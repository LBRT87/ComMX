# Review Ansible + Rekap Deploy ComMX

Dokumen pendamping untuk `Panduan-CICD-ComMX.md`. Isinya:
1. Fakta topologi jaringan yang sudah terverifikasi
2. Perbaikan yang perlu di Ansible temenmu
3. Perbaikan yang perlu di repo manifest (Git)
4. Rekap lengkap yang terjadi hari ini sampai berhasil deploy

---

## 1. FAKTA TOPOLOGI (terverifikasi, bukan asumsi)

Cluster tersebar di DUA subnet:

```
Subnet 192.168.3.x:  cp-01 (.21), cp-02 (.23), worker-01 (.20), worker-02 (.24)
Subnet 192.168.1.x:  cp-03 (.21), worker-03 (.22)
VM CI/CD (Forgejo):  192.168.2.5
K8s API VIP:         192.168.3.100:8443 (keepalived, HAProxy stacked di cp-01 & cp-02)
```

**MetalLB speaker HANYA di 4 node subnet 3.x** (cp-01, cp-02, worker-01, worker-02),
grup `[subnet3]` di inventory. Sebabnya: MetalLB L2 mengumumkan IP lewat **ARP**, dan
ARP tidak melewati router. Node di subnet 1.x tidak punya interface di subnet 3.x,
jadi tidak bisa mengumumkan IP pool 3.x.

**Pool MetalLB aktif & valid: `192.168.3.200-192.168.3.220`** (dari Ansible `pool.yaml.j2`).
Bukti nyata: `ComMX.local.com -> 192.168.3.203`, `Grafana -> 192.168.3.201`. Keduanya 3.x.

> KOREKSI: file `k8s/gateway/metallb.yaml` di repo Git menulis pool `192.168.1.200-220`
> dengan nodeSelector cp-03/worker-03. Itu SALAH secara teknis — tidak akan pernah jalan
> karena node 1.x bukan speaker. File itu harus diperbaiki ke 3.x atau dihapus, karena
> yang benar-benar mengassign IP adalah pool dari Ansible, bukan file ini.

---

## 2. PERBAIKAN DI ANSIBLE (roles/*)

Ansible temenmu sudah matang (HA, VRRP, pembatasan speaker sudah benar). Tapi ada
beberapa lubang yang persis bikin kita debug manual berjam-jam. Perbaiki ini:

### 2.1 Cilium — aktifkan Gateway API + install CRD  [KRITIKAL]
File: `roles/cluster/tasks/cni.yml`

Tambahkan di helm values Cilium:
```yaml
        values:
          ipam:
            mode: kubernetes
          k8sServiceHost: "{{ kube_vip }}"
          k8sServicePort: "{{ kube_lb_port }}"
          kubeProxyReplacement: "{{ cilium_replace_kubeproxy }}"
          operator:
            replicas: 2
          gatewayAPI:                 # <-- TAMBAH
            enabled: true             # <-- TAMBAH
```

Tambahkan task install CRD Gateway API SEBELUM install Cilium (Cilium butuh 6 CRD,
termasuk `tlsroutes` yang HANYA ada di channel experimental):
```yaml
    - name: Install Gateway API CRDs (standard)
      kubernetes.core.k8s:
        state: present
        kubeconfig: "{{ kubeconfig }}"
        src: https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.1.0/standard-install.yaml
    - name: Install Gateway API CRDs (experimental - butuh tlsroutes)
      kubernetes.core.k8s:
        state: present
        kubeconfig: "{{ kubeconfig }}"
        src: https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.1.0/experimental-install.yaml
```
Tanpa ini: GatewayClass stuck `ACCEPTED: Unknown`, error `tlsroutes CRD not found`.

### 2.2 Kyverno require-labels — exclude cilium-gateway  [KRITIKAL]
File: `roles/kyverno/templates/policies.yaml.j2`

Policy `require-labels` minta label `app`, `owner`, `app.kubernetes.io/name` untuk
Service juga. Tapi Service yang di-generate Cilium (`cilium-gateway-commx-gateway`)
tidak punya label itu -> Gateway gagal (`Unable to create Service, blocked by Kyverno`).

Tambahkan `cilium-gateway-*` ke exclude rule `check-required-labels`:
```yaml
      exclude:
        any:
          - resources:
              namespaces: [kube-system, kyverno, longhorn-system, metallb-system, monitoring, argocd, cicd]
          - resources:                        # <-- TAMBAH
              names: ["cilium-gateway-*"]      # <-- TAMBAH
```
> CATATAN: policy Ansible (3 label) sebenarnya LEBIH sesuai requirement soal daripada
> versi repo Git (1 label). Pertahankan yang 3 label, cukup tambah exclude di atas.
> Pastikan SEMUA manifest ComMX (deployment, service, statefulset) punya label
> `app`, `owner`, DAN `app.kubernetes.io/name`.

### 2.3 ArgoCD — apply Application yang mengarah ke repo  [KRITIKAL]
File: `roles/argocd/tasks/main.yml`

Role ini install ArgoCD tapi TIDAK apply Application. Akibatnya ArgoCD hidup tapi tidak
tahu harus deploy apa — GitOps tidak jalan otomatis. Tambahkan task:
```yaml
- name: Apply ArgoCD Application (commx-app)
  kubernetes.core.k8s:
    state: present
    kubeconfig: "{{ kubeconfig }}"
    definition:
      apiVersion: argoproj.io/v1alpha1
      kind: Application
      metadata:
        name: commx-app
        namespace: argocd
      spec:
        project: default
        source:
          repoURL: "http://{{ cicd_host_ip }}:{{ forgejo_http_port }}/prk/tpaonsite.git"
          targetRevision: main
          path: k8s
        destination:
          server: https://kubernetes.default.svc
          namespace: commx
        syncPolicy:
          automated:
            prune: true
            selfHeal: true
```

### 2.4 Nama secret registry — samakan  [PENTING]
File: `roles/argocd/tasks/main.yml`

Ansible bikin secret bernama `registry-cred`, tapi manifest deployment merujuk
`registry-credentials`. Mismatch = ImagePullBackOff. Ganti nama secret jadi
`registry-credentials` (atau ubah semua imagePullSecrets di manifest jadi `registry-cred`
— pilih satu, konsisten).

### 2.5 Registry TLS + distribusi cert ke node  [KRITIKAL]
Belum ada di Ansible sama sekali. Ini yang bikin error
`http: server gave HTTP response to HTTPS client` di semua node.

Butuh dua bagian:
- **Di VM Forgejo** (manual atau role terpisah): generate self-signed cert,
  jalankan registry dengan `REGISTRY_HTTP_TLS_CERTIFICATE` + `REGISTRY_HTTP_TLS_KEY`.
- **Di tiap node k8s** (tambah ke role `core_system` atau `cluster`): copy `domain.crt`
  ke `/usr/local/share/ca-certificates/registry.crt`, jalankan `update-ca-certificates`,
  restart containerd. Contoh task:
```yaml
- name: Copy registry CA cert ke node
  ansible.builtin.copy:
    src: files/registry-domain.crt
    dest: /usr/local/share/ca-certificates/registry-192-168-2-5.crt
- name: Update CA trust
  ansible.builtin.command: update-ca-certificates
- name: Restart containerd
  ansible.builtin.systemd:
    name: containerd
    state: restarted
```

### 2.6 (Opsional) Init database
Drizzle tidak auto-migrate. Tambah task/Job yang bikin tabel `users` setelah postgres
Ready, atau jalankan `drizzle-kit migrate` lewat Job. Sementara bisa manual (lihat panduan utama).

---

## 3. PERBAIKAN DI REPO MANIFEST (Git)

### 3.1 metallb.yaml — angka salah subnet
`k8s/gateway/metallb.yaml` tulis pool `192.168.1.200-220` (subnet salah).
Yang aktif & benar adalah `192.168.3.200-220`. Perbaiki file ini ATAU hapus dari repo
supaya tidak bentrok dengan pool Ansible. Kalau ada DUA IPAddressPool aktif di cluster,
MetalLB bisa bingung — cek `kubectl get ipaddresspool -A`, sisakan satu.

### 3.2 secret.yaml sempat ter-commit
File berisi credential DB. Sebelum push repo ke GitHub publik, buat repo PRIVATE atau
bersihkan history. Soal melarang push credential.

---

## 4. REKAP LENGKAP HARI INI (urut kejadian)

### Fase 1 — Bangun CI/CD dari nol
1. Setup VM + Docker + static IP (192.168.2.5, pakai nmcli/NetworkManager)
2. Deploy Forgejo (docker run, SQLite3, port 3000)
3. Deploy Private Registry (docker run, port 5000, htpasswd Group-1/kelargacor)
4. Setup Forgejo Actions Runner (register + config docker.sock + nohup)
5. Fork repo GitHub -> clone -> push ke Forgejo (branch main & dev)
6. Cek isi repo: backend NestJS, frontend Next.js (standalone, basePath /frontend)
7. Buat Dockerfile backend & frontend

### Fase 2 — Bangun pipeline CI (banyak error, semua terpecahkan)
8. Tulis `.forgejo/workflows/ci.yml` (GitLeaks -> Semgrep -> Trivy -> build -> Trivy -> push -> Checkov -> update manifest)
9. Debug berturut-turut: docker CLI not found, duplicate socket mount, node vs docker image,
   disk penuh (resize LVM), Trivy cache, Trivy image socket
10. Pipeline sukses 12 step, CI Bot auto-commit tag image -> ArgoCD detect

### Fase 3 — Deploy ke cluster (terima manifest dari tim, perbaiki)
11. Ambil manifest k8s dari tim, perbaiki: IP registry, path image group-2,
    port konsisten 3000, secret DB, secret registry-credentials, repoURL ArgoCD
12. Fix storageClassName postgres (local-path -> longhorn)
13. Fix backend CMD (dist/main -> dist/src/main)
14. Fix Redis permission (fsGroup + initContainer chown + runAsUser 999)
15. Fix Postgres lost+found (PGDATA subfolder)
16. Fix env kurang: JWT_SECRET, REDIS_URL, SOCKET_ORIGIN
17. Fix YAML indentation & CRLF di beberapa manifest

### Fase 4 — Networking & akses eksternal
18. Setup TLS registry + distribusi ca.crt ke 6 node (fix HTTP/HTTPS error)
19. Enable Cilium Gateway API + install CRD experimental (fix GatewayClass Unknown)
20. Pulihkan node NotReady & apiserver crash-loop (efek restart Cilium)
21. Fix Kyverno exclude cilium-gateway (fix Gateway Unable to create Service)
22. Buat Secret commx-tls-cert (fix Invalid CertificateRef)
23. Fix Envoy config port (fix no healthy upstream)
24. Setup DNS MikroTik (ComMX.local.com -> 192.168.3.203)

### Fase 5 — Aplikasi berfungsi end-to-end
25. Init tabel users di Postgres (Drizzle tidak auto-migrate)
26. Fix URLRewrite /api (fix login 404)
27. Hapus NetworkPolicy backend-isolation (fix login timeout)
28. Fix NEXT_PUBLIC_SOCKET_URL (buang /frontend, fix Invalid namespace) -> rebuild via pipeline
29. Fix SOCKET_ORIGIN case-sensitive (huruf kecil)
30. LOGIN & CHAT BERHASIL dari browser via https://ComMX.local.com/frontend

---

## 5. YANG MASIH BISA DIRAPIKAN (untuk nilai lebih / kalau ditanya)

- Runner -> systemd (jangan nohup) supaya tahan restart VM
- ArgoCD selfHeal harus ON dan Application ter-apply (biar GitOps beneran otomatis)
- metallb.yaml repo perbaiki ke subnet 3.x atau hapus
- Migrasi DB otomatis (Job drizzle-kit) daripada manual CREATE TABLE
- Basepath /frontend: kalau mau akses di root domain, tambah URLRewrite atau hapus basePath
- Dokumentasikan bahwa cert self-signed perlu di-trust sekali per PC klien
```

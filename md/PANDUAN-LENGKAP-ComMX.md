## DAFTAR ISI
1. Info penting (IP, kredensial)
2. Arsitektur singkat
3. Setup Disk VM dari awal + partisi
4. Bangun infrastruktur VM Forgejo
5. Repository (fork, clone, push)
6. Dockerfile backend & frontend
7. Workflow CI (.forgejo/workflows/ci.yml)
8. Kubernetes manifest (isi tiap file)
9. Deploy ke cluster (command config)
10. Urutan pengerjaan (checklist besar)
11. Ganti kredensial Group-1 -> Group-2
12. Strategi Kyverno di akhir
13. Verifikasi akhir
14. 30 Error & Solusi
15. Jawaban konsep (General Knowledge)
16. File apa disimpan di mana

---

# 1. INFO PENTING

```
Forgejo (Git + CI)  : 192.168.2.5:3000     (admin: prk)
Docker Registry     : 192.168.2.5:5000     (Group-2 / kelargacor, TLS)
Gateway LB IP       : dari pool 192.168.3.200-220 (mis. 192.168.3.203)
Grafana LB IP       : mis. 192.168.3.201
MikroTik            : 10.22.103.201
K8s API VIP         : 192.168.3.100:8443  (keepalived + HAProxy stacked cp-01,cp-02)
Database            : user_db / pass_db / commx_db
ArgoCD admin        : admin / <cek argocd-initial-admin-secret>
Login aplikasi      : ada / ada (auto-register)
DNS internal        : ComMX.local.com -> IP Gateway ; Grafana.local.com -> IP Grafana
```

### Topologi node (2 subnet)
```
Subnet 192.168.3.x: cp-01(.21) cp-02(.23) worker-01(.20) worker-02(.24)  <- MetalLB speaker
Subnet 192.168.1.x: cp-03(.21) worker-03(.22)
```
MetalLB L2 pakai ARP (tidak lewat router), jadi HANYA node subnet 3.x yang boleh jadi
speaker. Pool WAJIB 192.168.3.200-220. (File repo yang tulis 192.168.1.x = SALAH.)

---

# 2. ARSITEKTUR SINGKAT

```
push ke main (Forgejo)
  -> Runner jalankan CI: GitLeaks -> Semgrep -> Trivy(fs) -> build backend+frontend
     -> Trivy(image) -> push Registry -> Checkov -> update tag manifest -> commit balik
  -> ArgoCD deteksi commit -> sync manifest ke cluster
  -> Kubernetes pull image dari Registry -> jalankan pod
  -> User akses https://ComMX.local.com/frontend via Gateway(Cilium) + MetalLB
```

Dua sistem: **VM Forgejo** (Forgejo+Registry+Runner, container Docker biasa) dan
**Cluster Proxmox** (k8s + ArgoCD + aplikasi).

---

# 3. SETUP DISK VM DARI AWAL + PARTISI

VM Forgejo butuh disk besar (Docker build berulang + image + Trivy DB). Minimal **50GB**.
Kalau kurang, akan kena "database or disk is full" (Forgejo error 500).

## 3.1 Saat membuat VM
- Alokasikan disk 50GB dari awal, RAM minimal 4GB.

## 3.2 Perbesar disk kalau terlanjur kecil (LVM)

### Langkah 1 — perbesar disk di hypervisor
- **VMware Workstation**: VM OFF -> Edit VM Settings -> Hard Disk -> Expand -> 50 (total)
- **Proxmox**: VM -> Hardware -> Hard Disk -> Resize -> +40 (tambahan)

### Langkah 2 — perbesar partisi & LVM di dalam Ubuntu
```bash
lsblk                                    # cek nama device & partisi dulu
sudo apt update && sudo apt install -y cloud-guest-utils
sudo growpart /dev/sda 3                 # perbesar partisi (sesuaikan nomor)
sudo pvresize /dev/sda3                  # perbesar physical volume
sudo lvextend -l +100%FREE /dev/mapper/ubuntu--vg-ubuntu--lv
sudo resize2fs /dev/mapper/ubuntu--vg-ubuntu--lv
df -h /                                  # verifikasi -> ~48G
```
Catatan: device (`/dev/sda`), partisi (`3`), nama LV bisa beda — cek `lsblk` &
`sudo lvdisplay`. Kalau bukan LVM: cukup `growpart` + `resize2fs`.

### Darurat disk penuh saat kerja
```bash
docker builder prune -a -f
docker image prune -a -f
df -h /
```

---

# 4. INFRASTRUKTUR VM FORGEJO

## 4.1 Static IP (VM pakai NetworkManager)
```bash
nmcli connection show
sudo nmcli connection modify "Wired connection 1" \
  ipv4.addresses 192.168.2.5/24 ipv4.gateway 192.168.2.2 \
  ipv4.dns "8.8.8.8" ipv4.method manual
sudo nmcli connection up "Wired connection 1"
```

## 4.2 Docker
```bash
docker run hello-world
sudo usermod -aG docker $USER && newgrp docker
```

## 4.3 Forgejo
```bash
mkdir -p /root/cicd/forgejo-data
docker run -d --name forgejo \
  -e USER_UID=1000 -e USER_GID=1000 \
  -e FORGEJO__server__DOMAIN=192.168.2.5 \
  -e FORGEJO__server__ROOT_URL=http://192.168.2.5:3000/ \
  -e FORGEJO__actions__ENABLED=true \
  -p 3000:3000 -p 2222:22 \
  -v /root/cicd/forgejo-data:/data --restart always \
  codeberg.org/forgejo/forgejo:9
```
Buka http://192.168.2.5:3000 -> wizard -> Database SQLite3 -> buat admin (prk).

## 4.4 Private Registry (TLS) — pakai Group-2
```bash
mkdir -p /home/forgejo/registry/{auth,data,certs}

# htpasswd untuk Group-2
docker run --rm --entrypoint htpasswd httpd:2 -Bbn Group-2 kelargacor \
  > /home/forgejo/registry/auth/htpasswd

# self-signed cert
openssl req -newkey rsa:4096 -nodes -sha256 \
  -keyout /home/forgejo/registry/certs/domain.key \
  -x509 -days 365 -out /home/forgejo/registry/certs/domain.crt \
  -subj "/CN=192.168.2.5" -addext "subjectAltName=IP:192.168.2.5"

docker run -d --name registry -p 5000:5000 \
  -e REGISTRY_AUTH=htpasswd \
  -e REGISTRY_AUTH_HTPASSWD_REALM=Registry \
  -e REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd \
  -e REGISTRY_HTTP_TLS_CERTIFICATE=/certs/domain.crt \
  -e REGISTRY_HTTP_TLS_KEY=/certs/domain.key \
  -v /home/forgejo/registry/auth:/auth \
  -v /home/forgejo/registry/certs:/certs \
  -v /home/forgejo/registry/data:/var/lib/registry \
  --restart always registry:2

docker login 192.168.2.5:5000 -u Group-2 -p kelargacor
curl -k https://192.168.2.5:5000/v2/_catalog -u Group-2:kelargacor
```

## 4.5 Runner
```bash
wget https://code.forgejo.org/forgejo/runner/releases/download/v3.5.0/forgejo-runner-3.5.0-linux-amd64
chmod +x forgejo-runner-3.5.0-linux-amd64
sudo mv forgejo-runner-3.5.0-linux-amd64 /usr/local/bin/forgejo-runner

# token dari Forgejo: Site Administration -> Actions -> Runners
forgejo-runner register --instance http://192.168.2.5:3000 \
  --token <TOKEN> --name runner-1 --no-interactive

forgejo-runner generate-config > /home/forgejo/config.yml
# edit config.yml -> container: valid_volumes: ["/var/run/docker.sock"]
```

### Runner sebagai systemd (WAJIB, jangan nohup)
```bash
sudo tee /etc/systemd/system/forgejo-runner.service <<EOF
[Unit]
Description=Forgejo Actions Runner
After=docker.service
[Service]
ExecStart=/usr/local/bin/forgejo-runner daemon -c /home/forgejo/config.yml
WorkingDirectory=/home/forgejo
Restart=always
User=root
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now forgejo-runner
sudo systemctl status forgejo-runner
```

---

# 5. REPOSITORY

```bash
# Fork https://github.com/KenHoH/ComMX ke akun GitHub (lewat web)
git clone https://github.com/<username>/ComMX.git
cd ComMX
git checkout -b dev && git push origin dev
git checkout main
git remote add forgejo http://192.168.2.5:3000/prk/tpaonsite.git
git push forgejo main
git push forgejo dev
```
`.env` & credential JANGAN ke-push (`.gitignore`).

---

# 6. DOCKERFILE

## backend/Dockerfile
```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/src/main"]     # dist/src/main, BUKAN dist/main
```

## frontend/Dockerfile (Next.js output: standalone)
```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
ARG NEXT_PUBLIC_SOCKET_URL
ARG NEXT_PUBLIC_BACKEND_URL
ENV NEXT_PUBLIC_SOCKET_URL=$NEXT_PUBLIC_SOCKET_URL
ENV NEXT_PUBLIC_BACKEND_URL=$NEXT_PUBLIC_BACKEND_URL
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
EXPOSE 3000
CMD ["node", "server.js"]
```
KUNCI: `NEXT_PUBLIC_*` di-BAKE saat build (build-time), tidak bisa lewat Secret.
Ganti nilai = harus rebuild image, bukan restart pod.

---

# 7. WORKFLOW CI (.forgejo/workflows/ci.yml)

```yaml
name: CI-CD
on:
  push:
    branches: [main]

jobs:
  ci:
    runs-on: docker
    container:
      image: node:20-bullseye
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Install Docker CLI
        run: apt-get update && apt-get install -y docker.io

      - name: GitLeaks Scan
        run: docker run --rm -v $PWD:/repo zricethezav/gitleaks:latest detect --source=/repo --no-git -v

      - name: Semgrep Scan
        run: docker run --rm -v $PWD:/src returntocorp/semgrep semgrep --config=auto /src

      - name: Trivy Filesystem Scan
        run: docker run --rm -v $PWD:/repo -v trivy-cache:/root/.cache/trivy aquasec/trivy fs --severity HIGH,CRITICAL /repo

      - name: Build Backend Image
        run: docker build -t 192.168.2.5:5000/group-2/commx-backend:${{ gitea.sha }} ./backend

      - name: Build Frontend Image
        run: |
          docker build \
            --build-arg NEXT_PUBLIC_SOCKET_URL=wss://ComMX.local.com \
            --build-arg NEXT_PUBLIC_BACKEND_URL=https://ComMX.local.com/api \
            -t 192.168.2.5:5000/group-2/commx-frontend:${{ gitea.sha }} ./frontend

      - name: Trivy Image Scan
        run: |
          docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v trivy-cache:/root/.cache/trivy aquasec/trivy image 192.168.2.5:5000/group-2/commx-backend:${{ gitea.sha }}
          docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v trivy-cache:/root/.cache/trivy aquasec/trivy image 192.168.2.5:5000/group-2/commx-frontend:${{ gitea.sha }}

      - name: Push to Registry
        run: |
          echo "kelargacor" | docker login 192.168.2.5:5000 -u Group-2 --password-stdin
          docker push 192.168.2.5:5000/group-2/commx-backend:${{ gitea.sha }}
          docker push 192.168.2.5:5000/group-2/commx-frontend:${{ gitea.sha }}

      - name: Checkov IaC Scan
        run: docker run --rm -v $PWD/k8s:/k8s bridgecrew/checkov -d /k8s --skip-path /k8s/config/secret.example.yaml

      - name: Update K8s Manifest
        run: |
          sed -i "s|commx-backend:.*|commx-backend:${{ gitea.sha }}|" k8s/backend/deployment.yaml
          sed -i "s|commx-frontend:.*|commx-frontend:${{ gitea.sha }}|" k8s/frontend/deployment.yaml
          git config user.email "ci-bot@forgejo.local"
          git config user.name "CI Bot"
          git add k8s/backend/deployment.yaml k8s/frontend/deployment.yaml
          git commit -m "ci: update image tag to ${{ gitea.sha }}"
          git push http://ci-bot:${{ secrets.CI_TOKEN }}@192.168.2.5:3000/prk/tpaonsite.git main
```
Buat `CI_TOKEN` di Forgejo (Settings->Applications, scope write:repository),
simpan di Repo Settings -> Actions -> Secrets.

---

# 8. KUBERNETES MANIFEST (poin per file)

**config/configmap.yaml** — `PORT: "3000"`, NODE_ENV, REDIS_HOST, REDIS_PORT.

**config/secret.yaml** (JANGAN commit, gitignore):
```yaml
stringData:
  POSTGRES_USER: "user_db"
  POSTGRES_PASSWORD: "pass_db"
  POSTGRES_DB: "commx_db"
  DATABASE_URL: "postgresql://user_db:pass_db@postgres.commx.svc.cluster.local:5432/commx_db"
  JWT_SECRET: "<random>"
  SOCKET_ORIGIN: "https://commx.local.com"   # HURUF KECIL (CORS case-sensitive)
  REDIS_URL: "redis://redis:6379"
```

**backend & frontend deployment** — port 3000, label `app`+`owner`+`app.kubernetes.io/name`,
`imagePullSecrets: registry-credentials`, image `group-2/...`.

**redis/statefulset.yaml** — `securityContext.fsGroup: 999` + initContainer busybox
`chown -R 999:999 /data` (runAsUser 0) + container `runAsUser: 999`.

**postgres/statefulset.yaml** — `storageClassName: "longhorn"`, env `PGDATA: /var/lib/postgresql/data/pgdata`.

**gateway/httproute.yaml** — 3 rule:
```yaml
rules:
  - matches: [{path: {type: PathPrefix, value: /api}}]
    filters:
      - type: URLRewrite
        urlRewrite: {path: {type: ReplacePrefixMatch, replacePrefixMatch: /}}
    backendRefs: [{name: backend, port: 3000}]
  - matches: [{path: {type: PathPrefix, value: /socket.io}}]
    backendRefs: [{name: backend, port: 3000}]
  - matches: [{path: {type: PathPrefix, value: /}}]
    backendRefs: [{name: frontend, port: 3000}]
```

**gateway/metallb.yaml** — pool `192.168.3.200-220` (BUKAN 1.x), speaker node subnet 3.x.

**policies/kyverno-policies.yaml** — 3 policy (disallow-latest-tag, disallow-default-namespace,
require-labels) + `exclude names: ["cilium-gateway-*"]`.

**argocd/application.yaml** — repoURL ke Forgejo, path k8s, syncPolicy automated selfHeal.

---

# 9. DEPLOY KE CLUSTER (command config)

## 9.1 Akses cluster
```bash
mkdir -p ~/.kube
# copy /etc/kubernetes/admin.conf dari control plane ke ~/.kube/config
kubectl get nodes
```

## 9.2 Secret
```bash
kubectl create secret docker-registry registry-credentials \
  --docker-server=192.168.2.5:5000 \
  --docker-username=Group-2 --docker-password=kelargacor -n commx

kubectl apply -f k8s/config/secret.yaml

openssl req -newkey rsa:2048 -nodes -keyout /tmp/tls.key \
  -x509 -days 365 -out /tmp/tls.crt \
  -subj "/CN=commx.local.com" -addext "subjectAltName=DNS:commx.local.com"
kubectl create secret tls commx-tls-cert --cert=/tmp/tls.crt --key=/tmp/tls.key -n commx
```

## 9.3 Gateway API CRD
```bash
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.1.0/standard-install.yaml
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.1.0/experimental-install.yaml
```

## 9.4 Enable Cilium Gateway API (di control plane)
```bash
helm get values cilium -n kube-system -o yaml > cilium-values.yaml
# tambah: gatewayAPI: {enabled: true}
helm upgrade cilium cilium/cilium -n kube-system --version 1.16.5 -f cilium-values.yaml
kubectl rollout restart deployment cilium-operator -n kube-system
kubectl rollout restart daemonset cilium -n kube-system
kubectl get gatewayclass     # tunggu ACCEPTED True
```

## 9.5 Distribusi cert registry ke SETIAP node (6 node)
```bash
sudo mkdir -p /etc/containerd/certs.d/192.168.2.5:5000
sudo cp domain.crt /usr/local/share/ca-certificates/registry-192-168-2-5.crt
sudo update-ca-certificates
sudo tee /etc/containerd/certs.d/192.168.2.5:5000/hosts.toml <<'EOF'
server = "https://192.168.2.5:5000"
[host."https://192.168.2.5:5000"]
  capabilities = ["pull", "resolve"]
  ca = ["/etc/containerd/certs.d/192.168.2.5:5000/ca.crt"]
EOF
sudo systemctl restart containerd
```

## 9.6 ArgoCD Application
```bash
kubectl apply -f k8s/argocd/application.yaml
kubectl get application commx-app -n argocd
```

## 9.7 Init database (Drizzle tidak auto-migrate)
```bash
kubectl exec -n commx postgres-0 -- psql -U user_db -d commx_db -c \
  "CREATE TABLE IF NOT EXISTS users (id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, username VARCHAR(255) NOT NULL, password VARCHAR(255) NOT NULL);"
```

## 9.8 DNS MikroTik
```
/ip dns set servers=10.22.64.21,10.22.64.22 allow-remote-requests=yes
/ip dns static add name=ComMX.local.com address=<IP-GATEWAY-pool-3.x>
/ip dns static add name=Grafana.local.com address=<IP-GRAFANA>
```
Pastikan PC klien pakai MikroTik (10.22.103.201) sebagai DNS server.

---

# 10. URUTAN PENGERJAAN (checklist besar)

**TAHAP 1 — VM Forgejo (sendiri, tanpa cluster)**
1. Setup VM + disk 50GB (Bagian 3) + static IP
2. Install Docker
3. Forgejo (docker run)
4. Registry TLS + htpasswd Group-2
5. Runner (systemd)

**TAHAP 2 — Repo**
6. Fork -> clone -> branch dev -> push ke Forgejo
7. Pastikan Dockerfile backend & frontend benar
8. Pastikan ci.yml benar (Group-2, socket URL tanpa /frontend)

**TAHAP 3 — Manifest k8s (koordinasi tim)**
9. configmap, secret, deployment x2, statefulset x2, service, gateway, policies, argocd
   (semua poin di Bagian 8)

**TAHAP 4 — CI**
10. Push ke main -> pipeline jalan -> image ke registry -> CI Bot update tag

**TAHAP 5 — Cluster**
11. kubeconfig -> secret (3) -> Gateway CRD -> Cilium gatewayAPI -> cert ke node
    -> ArgoCD Application -> init DB -> DNS

**TAHAP 6 — Kyverno (PALING AKHIR, lihat Bagian 12)**

**TAHAP 7 — Verifikasi (Bagian 13)**

---

# 11. GANTI KREDENSIAL Group-1 -> Group-2

Ada DUA "group" berbeda:
- **Username registry** (`Group-1`) -> ganti ke `Group-2`
- **Path image** (`group-2/commx-backend`) -> sudah benar, JANGAN diubah

### Yang harus diganti:
```bash
# 1. ci.yml
sed -i 's/-u Group-1/-u Group-2/' .forgejo/workflows/ci.yml
git add .forgejo/workflows/ci.yml && git commit -m "chore: registry user Group-2" && git push forgejo main

# 2. htpasswd
docker run --rm --entrypoint htpasswd httpd:2 -Bbn Group-2 kelargacor \
  > /home/forgejo/registry/auth/htpasswd
docker restart registry
docker login 192.168.2.5:5000 -u Group-2 -p kelargacor

# 3. secret registry
kubectl delete secret registry-credentials -n commx
kubectl create secret docker-registry registry-credentials \
  --docker-server=192.168.2.5:5000 \
  --docker-username=Group-2 --docker-password=kelargacor -n commx
```
Kalau kelompok bukan 2, sesuaikan angka di ci.yml + kedua deployment.yaml + registry.

---

# 12. STRATEGI KYVERNO DI AKHIR

Kyverno = "satpam" yang cek resource sebelum masuk. Kalau dipasang duluan dengan aturan
ketat, bisa memblokir instalasi komponen lain. Maka pasang PALING AKHIR (Ansible juga begitu).

**Langkah:**
1. Deploy semua dulu tanpa Kyverno (comment baris `policies/kyverno-policies.yaml`
   di kustomization.yaml, atau jalankan Ansible tanpa tag kyverno).
2. Pastikan aplikasi jalan penuh (pod Running, login & chat OK).
3. BARU apply Kyverno.

**Sebelum apply Kyverno, pastikan semua manifest sudah comply:**
- Semua Deployment/StatefulSet/Service punya label `app`, `owner`, `app.kubernetes.io/name`
- Tidak ada image `:latest`
- Tidak ada resource di namespace `default`
- Policy require-labels punya `exclude names: ["cilium-gateway-*"]`

**Kalau buru-buru & masih ada yg ke-block:** sementara ubah
`validationFailureAction: Enforce` -> `Audit` (tetap mencatat, tidak memblokir).
Tapi idealnya tetap `Enforce` sesuai soal.

> PENTING: Kyverno WAJIB ada (requirement soal). "Di akhir" boleh, "tidak ada" tidak boleh.

---

# 13. VERIFIKASI AKHIR

```bash
kubectl get pods -n commx                       # semua 1/1 Running
kubectl get application commx-app -n argocd      # Synced / Healthy
kubectl get gateway commx-gateway -n commx       # PROGRAMMED True + ADDRESS
kubectl get clusterpolicy                        # 3 policy Ready

# test login via Gateway
curl -k -X POST -H "Host: commx.local.com" -H "Content-Type: application/json" \
  -d '{"username":"ada","password":"ada"}' https://<IP-GATEWAY>/api/auth/login
# -> {"token":"..."}

# browser: https://commx.local.com/frontend  (basePath /frontend), login ada/ada
```

---

# 14. 30 ERROR & SOLUSI

**E1** `docker: command not found` di pipeline -> container job tak ada docker cli.
Solusi: step `apt-get install -y docker.io`.

**E2** `Duplicate mount point: /var/run/docker.sock` -> socket dimount 2x.
Solusi: config.yml runner cukup `valid_volumes`, hapus `options:`.

**E3** `exec: "node": not found` -> base image docker:24-cli tak ada Node.
Solusi: pakai node:20-bullseye, install docker.io di dalamnya.

**E4** `database or disk is full` (Forgejo 500) -> disk VM penuh.
Solusi: `docker builder/image prune`, resize disk (Bagian 3).

**E5** Trivy `no space left` -> Trivy download DB 110MB tiap run.
Solusi: `-v trivy-cache:/root/.cache/trivy`.

**E6** Runner "Waiting"/offline setelah restart VM -> nohup mati.
Solusi: pakai systemd.

**E7** Trivy Image Scan `unable to find image` -> Trivy tak akses docker daemon.
Solusi: `-v /var/run/docker.sock:/var/run/docker.sock`.

**E8** postgres Pending, PVC unbound -> storageClassName `local-path` tak ada.
Solusi: ganti `longhorn`; PVC immutable -> hapus StatefulSet+PVC, biar dibuat ulang.

**E9** backend `Cannot find module '/app/dist/main'` -> output di dist/src/main.js.
Solusi: `CMD ["node","dist/src/main"]`.

**E10** redis `chown: Operation not permitted` -> caps drop ALL + lost+found.
Solusi: fsGroup 999 + initContainer chown + runAsUser 999.

**E11** redis `failed switching to "redis"` -> image switch user tapi caps dicabut.
Solusi: `runAsUser: 999` langsung.

**E12** postgres `directory exists but not empty ... lost+found`.
Solusi: env `PGDATA: /var/lib/postgresql/data/pgdata`.

**E13** backend MODULE_NOT_FOUND padahal sudah fix -> manifest pakai tag lama.
Solusi: pastikan pipeline sukses + ArgoCD sync revisi terbaru.

**E14** backend `JwtStrategy requires a secret` -> JWT_SECRET belum ada.
Solusi: tambah di secret.yaml.

**E15** backend `ECONNREFUSED 127.0.0.1:6379` -> REDIS_URL belum diset.
Solusi: tambah `REDIS_URL: redis://redis:6379`.

**E16** YAML `MalformedYAMLError` -> salah indentasi/CRLF/label di luar labels.
Solusi: perbaiki indentasi, `dos2unix`, validasi `python3 -c "import yaml;yaml.safe_load(...)"`.

**E17** node k8s `http: server gave HTTP response to HTTPS client` -> registry HTTP.
Solusi: pasang TLS registry + distribusi ca.crt ke tiap node.

**E18** `x509: certificate signed by unknown authority` -> ca.crt belum dipercaya.
Solusi: cp ke /usr/local/share/ca-certificates + update-ca-certificates + restart containerd.

**E19** node NotReady + apiserver crash-loop setelah restart Cilium.
Solusi: `systemctl restart containerd && systemctl restart kubelet` di node terdampak.

**E20** Kyverno webhook `operation not permitted` / admission 0/1 -> efek restart Cilium.
Solusi: tunggu Cilium & node stabil, pod Kyverno balik Running.

**E21** GatewayClass Unknown / `tlsroutes CRD not found` -> kurang CRD experimental.
Solusi: apply experimental-install.yaml.

**E22** Gateway `Unable to create Service, blocked by Kyverno` -> Service cilium-gateway tanpa label.
Solusi: exclude `cilium-gateway-*` di policy require-labels.

**E23** Gateway `Invalid CertificateRef` -> secret commx-tls-cert belum ada.
Solusi: `kubectl create secret tls commx-tls-cert ...`.

**E24** `no healthy upstream` -> Envoy config port lama.
Solusi: perbaiki port httproute, delete ciliumenvoyconfig, restart cilium-operator.

**E25** login 404 `Cannot POST /api/auth/login` -> prefix /api tak dihapus.
Solusi: URLRewrite ReplacePrefixMatch di rule /api.

**E26** login `connection timeout` -> NetworkPolicy backend-isolation blokir Envoy.
Solusi: hapus commx-backend-isolation (pertahankan database-isolation).

**E27** chat `Could not reach chat server` / `Invalid namespace`
-> NEXT_PUBLIC_SOCKET_URL berisi /frontend.
Solusi: `wss://ComMX.local.com` (tanpa /frontend), rebuild image.

**E28** chat gagal walau socket URL benar -> CORS SOCKET_ORIGIN huruf besar.
Solusi: `SOCKET_ORIGIN: https://commx.local.com` (kecil).

**E29** pod pakai tag lama walau sudah push -> ArgoCD selfHeal off/belum sync.
Solusi: nyalakan selfHeal, patch sync HEAD, atau kubectl apply manual.

**E30** frontend `Failed to fetch` di PC lain -> cert self-signed belum dipercaya / DNS salah.
Solusi: akses /api/auth/profile sekali (Advanced->Proceed); pastikan DNS PC = MikroTik.

---

# 15. JAWABAN KONSEP (General Knowledge)

- **DevOps**: menyatukan Development + Operations untuk rilis cepat & otomatis.
- **DevSecOps**: DevOps + security di tiap tahap (shift-left) = GitLeaks, Semgrep, Trivy, Checkov.
- **GitOps**: Git = sumber kebenaran; ArgoCD sinkronkan cluster ke isi Git otomatis.
- **Runner**: agen yang eksekusi step pipeline di mesin nyata (bukan di server Git).
- **CI vs CD**: CI = integrasi+scan+build otomatis; CD = deploy otomatis
  (Deployment=langsung prod, Delivery=butuh approval).
- **Kenapa NEXT_PUBLIC lewat build-arg bukan Secret**: di-bake ke JS bundle saat build,
  tidak dibaca saat runtime.
- **Kenapa Registry TLS di tiap node**: containerd tiap node harus percaya cert untuk pull.
- **Kenapa commit SHA jadi tag**: immutable & unik per commit, mudah trace & rollback,
  penuhi Kyverno disallow-latest.
- **Deployment strategy**: RollingUpdate (maxSurge 1, maxUnavailable 0) = zero-downtime.
- **Kenapa MetalLB pool harus subnet node speaker**: L2 pakai ARP, tidak lewat router.
- **Kenapa Kyverno terakhir**: policy-nya bisa memblokir instalasi komponen lain.

---

# 16. FILE APA DISIMPAN DI MANA

**Di REPO GIT (commit, aman dilihat):**
Dockerfile, semua k8s/ manifest, .forgejo/workflows/ci.yml, secret.example.yaml,
kode aplikasi.

**RAHASIA — hanya di VM/cluster + backup manual, JANGAN commit:**
| File | Lokasi | Digenerate / Manual |
|---|---|---|
| secret.yaml | VM: k8s/config/secret.yaml (gitignore) | Manual (isi nilai) |
| config.yml runner | VM: /home/forgejo/config.yml | Digenerate lalu diedit |
| domain.crt + key | VM: /home/forgejo/registry/certs/ | Digenerate (openssl) |
| htpasswd | VM: /home/forgejo/registry/auth/ | Digenerate (htpasswd) |
| kubeconfig | VM: /root/.kube/config | Digenerate (kubeadm) |
| commx-tls-cert | cluster (backup yaml) | Digenerate |
| registry-credentials | cluster (backup yaml) | Digenerate |

**Config OS node (di tiap node, di-manage Ansible):**
/etc/containerd/certs.d/192.168.2.5:5000/ (ca.crt + hosts.toml)

**Ansible (repo terpisah / K2Help):**
FinalAnsible/ — site.yml, roles/, group_vars/, inventory/

Backup command untuk tarik ke laptop:
```
scp forgejo@192.168.2.5:/home/forgejo/backup-tpa.tar.gz D:\LatihanOnsiteNetwork\
```
```

---

# 17. SEMUA FILE YANG PERLU DIBUAT (checklist + lokasi + cara)

Daftar tunggal semua file yang HARUS dibuat manual saat setup (tidak datang otomatis
dari clone repo). Urut sesuai kapan dibutuhkan.

## A. Di VM FORGEJO

### A1. docker-compose / folder data Forgejo — OTOMATIS
- Lokasi: `/root/cicd/forgejo-data/`
- Cara: otomatis dibuat saat `docker run forgejo` (Bagian 4.3). Tidak perlu bikin manual.

### A2. htpasswd (password registry) — BUAT MANUAL
- Lokasi: `/home/forgejo/registry/auth/htpasswd`
- Cara:
```bash
mkdir -p /home/forgejo/registry/auth
docker run --rm --entrypoint htpasswd httpd:2 -Bbn Group-2 kelargacor \
  > /home/forgejo/registry/auth/htpasswd
```

### A3. Sertifikat registry (domain.crt + domain.key) — BUAT MANUAL
- Lokasi: `/home/forgejo/registry/certs/domain.crt` & `domain.key`
- Cara:
```bash
mkdir -p /home/forgejo/registry/certs
openssl req -newkey rsa:4096 -nodes -sha256 \
  -keyout /home/forgejo/registry/certs/domain.key \
  -x509 -days 365 -out /home/forgejo/registry/certs/domain.crt \
  -subj "/CN=<IP-REGISTRY>" -addext "subjectAltName=IP:<IP-REGISTRY>"
```

### A4. config.yml runner — GENERATE lalu EDIT
- Lokasi: `/home/forgejo/config.yml`
- Cara:
```bash
forgejo-runner generate-config > /home/forgejo/config.yml
nano /home/forgejo/config.yml
```
- Isi MINIMAL yang penting (sisanya boleh default):
```yaml
log:
  level: info
runner:
  file: .runner
  capacity: 1
  timeout: 3h
  fetch_timeout: 5s
  fetch_interval: 2s
  labels: []
cache:
  enabled: true
container:
  valid_volumes:
    - /var/run/docker.sock      # <-- WAJIB, ini yang bikin pipeline bisa akses docker
host:
  workdir_parent:
```

### A5. .runner (hasil registrasi) — OTOMATIS
- Lokasi: `/home/forgejo/.runner`
- Cara: otomatis saat `forgejo-runner register ...` (Bagian 4.5). Jangan diisi manual.

### A6. service systemd runner — BUAT MANUAL
- Lokasi: `/etc/systemd/system/forgejo-runner.service`
- Cara: lihat Bagian 4.5 (blok `tee ... forgejo-runner.service`).

### A7. /etc/docker/daemon.json — BUAT MANUAL (hanya jika registry HTTP tanpa TLS)
- Lokasi: `/etc/docker/daemon.json`
- Cara (SKIP kalau pakai TLS seperti panduan ini):
```json
{ "insecure-registries": ["<IP-REGISTRY>:5000"] }
```

## B. Di dalam REPO (folder ComMX)

### B1. secret.yaml (credential DB) — BUAT MANUAL, gitignored
- Lokasi: `k8s/config/secret.yaml`
- Cara:
```bash
cp k8s/config/secret.example.yaml k8s/config/secret.yaml
nano k8s/config/secret.yaml     # isi nilai, SOCKET_ORIGIN huruf kecil
```
- Pastikan ada di `.gitignore`: `k8s/config/secret.yaml`

### B2. Dockerfile backend & frontend — SUDAH di repo (tinggal cek benar)
- Lokasi: `backend/Dockerfile`, `frontend/Dockerfile`
- Cek: CMD backend `dist/src/main`, frontend standalone (Bagian 6).

### B3. .forgejo/workflows/ci.yml — SUDAH di repo (tinggal ganti nilai)
- Lokasi: `.forgejo/workflows/ci.yml`
- Ganti: IP, username Group, path image, domain (lihat dokumen PERSIAPAN-UJIAN).

## C. Di FORGEJO (lewat UI, bukan file)

### C1. CI_TOKEN — BUAT MANUAL
- Lokasi: Forgejo UI -> Settings -> Applications -> Generate Token (scope write:repository)
- Simpan di: Repo -> Settings -> Actions -> Secrets -> nama `CI_TOKEN`
- WAJIB, tanpa ini step "Update K8s Manifest" gagal.

## D. Di CLUSTER (lewat kubectl, bukan file di repo)

### D1. kubeconfig — AMBIL dari control plane
- Lokasi: `~/.kube/config` (di VM yang jalankan kubectl)
- Cara: copy isi `/etc/kubernetes/admin.conf` dari control plane.

### D2. Secret registry-credentials — BUAT MANUAL
```bash
kubectl create secret docker-registry registry-credentials \
  --docker-server=<IP-REGISTRY>:5000 \
  --docker-username=Group-2 --docker-password=kelargacor -n commx
```

### D3. Secret commx-secret (DB) — dari secret.yaml
```bash
kubectl apply -f k8s/config/secret.yaml
```

### D4. Secret commx-tls-cert (TLS Gateway) — BUAT MANUAL
```bash
openssl req -newkey rsa:2048 -nodes -keyout /tmp/tls.key \
  -x509 -days 365 -out /tmp/tls.crt \
  -subj "/CN=<domain>" -addext "subjectAltName=DNS:<domain>"
kubectl create secret tls commx-tls-cert --cert=/tmp/tls.crt --key=/tmp/tls.key -n commx
```

## E. Di TIAP NODE K8S (6 node) — BUAT MANUAL / via Ansible

### E1. ca.crt registry
- Lokasi: `/etc/containerd/certs.d/<IP-REGISTRY>:5000/ca.crt`
  dan `/usr/local/share/ca-certificates/registry-<ip>.crt`

### E2. hosts.toml
- Lokasi: `/etc/containerd/certs.d/<IP-REGISTRY>:5000/hosts.toml`
- Cara: lihat Bagian 9.5. (Kalau pakai Ansible K2Help, ini otomatis.)

---

## CHECKLIST FILE YANG DIBUAT (centang saat ujian)

VM Forgejo:
- [ ] htpasswd (A2)
- [ ] domain.crt + domain.key (A3)
- [ ] config.yml runner + edit valid_volumes (A4)
- [ ] forgejo-runner.service systemd (A6)

Repo:
- [ ] secret.yaml (B1) + pastikan gitignored
- [ ] cek Dockerfile & ci.yml, ganti semua nilai environment

Forgejo UI:
- [ ] CI_TOKEN (C1)

Cluster:
- [ ] kubeconfig (D1)
- [ ] secret registry-credentials (D2)
- [ ] secret commx-secret (D3)
- [ ] secret commx-tls-cert (D4)

Tiap node (atau via Ansible):
- [ ] ca.crt + hosts.toml di 6 node (E1, E2)

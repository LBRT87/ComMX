# Panduan Lengkap CI/CD Pipeline — ComMX (Net 26-1 Onsite)

Dokumen ini merangkum seluruh langkah membangun CI/CD pipeline dari nol sampai aplikasi
bisa diakses dari browser, plus daftar semua error yang muncul beserta solusinya.

---

## DAFTAR IP & KREDENSIAL (hafalkan / catat terpisah)

```
Forgejo (Git + CI)  : 192.168.2.5:3000     (admin: prk)
Docker Registry     : 192.168.2.5:5000     (Group-1 / kelargacor, pakai TLS)
Gateway LB IP       : 192.168.3.203        (dari MetalLB)
MikroTik            : 10.22.103.201
K8s API server      : 192.168.3.100:8443
Database            : user_db / pass_db / commx_db
ArgoCD admin        : admin / 0OYTlc9V21IU3sxM
Login aplikasi      : ada / ada (auto-register)
DNS internal        : ComMX.local.com -> 192.168.3.203
```

---

## ARSITEKTUR SINGKAT

```
Developer push ke branch main (Forgejo)
   -> Forgejo Actions Runner jalankan pipeline CI:
      GitLeaks -> Semgrep -> Trivy(fs) -> Build image -> Trivy(image)
      -> Push ke Registry -> Checkov -> Update tag manifest -> commit balik
   -> ArgoCD deteksi commit baru di repo -> sync ke cluster
   -> Kubernetes tarik image dari Registry -> jalankan pod
   -> User akses https://ComMX.local.com/frontend lewat Gateway (Cilium) + MetalLB
```

Dua sistem terpisah yang terhubung lewat jaringan:
- **PC/VM Forgejo** (192.168.2.5): Forgejo, Registry, Runner — semua container Docker biasa.
- **Cluster Proxmox**: 3 control plane + 3 worker (k8s), ArgoCD, aplikasi ComMX.

---

# BAGIAN 1 — SETUP INFRASTRUKTUR (VM Forgejo)

## 1.1 VM & Docker

```bash
# Set static IP (VM pakai NetworkManager, bukan netplan biasa)
nmcli connection show
sudo nmcli connection modify "Wired connection 1" \
  ipv4.addresses 192.168.2.5/24 \
  ipv4.gateway 192.168.2.2 \
  ipv4.dns "8.8.8.8" \
  ipv4.method manual
sudo nmcli connection up "Wired connection 1"

# Install Docker (repo resmi docs.docker.com)
docker run hello-world   # verifikasi
sudo usermod -aG docker $USER && newgrp docker
```

## 1.2 Forgejo (via docker run)

```bash
mkdir -p /root/cicd/forgejo-data
docker run -d --name forgejo \
  -e USER_UID=1000 -e USER_GID=1000 \
  -e FORGEJO__server__DOMAIN=192.168.2.5 \
  -e FORGEJO__server__ROOT_URL=http://192.168.2.5:3000/ \
  -e FORGEJO__actions__ENABLED=true \
  -p 3000:3000 -p 2222:22 \
  -v /root/cicd/forgejo-data:/data \
  --restart always \
  codeberg.org/forgejo/forgejo:9
```
Buka http://192.168.2.5:3000 -> wizard install -> Database **SQLite3** -> buat admin.

## 1.3 Private Docker Registry (dengan TLS)

```bash
mkdir -p /home/forgejo/registry/{auth,data,certs}

# htpasswd untuk autentikasi
docker run --rm --entrypoint htpasswd httpd:2 -Bbn Group-1 kelargacor \
  > /home/forgejo/registry/auth/htpasswd

# Self-signed certificate (WAJIB, lihat error HTTP/HTTPS di bawah)
openssl req -newkey rsa:4096 -nodes -sha256 \
  -keyout /home/forgejo/registry/certs/domain.key \
  -x509 -days 365 \
  -out /home/forgejo/registry/certs/domain.crt \
  -subj "/CN=192.168.2.5" \
  -addext "subjectAltName=IP:192.168.2.5"

docker run -d --name registry \
  -p 5000:5000 \
  -e REGISTRY_AUTH=htpasswd \
  -e REGISTRY_AUTH_HTPASSWD_REALM=Registry \
  -e REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd \
  -e REGISTRY_HTTP_TLS_CERTIFICATE=/certs/domain.crt \
  -e REGISTRY_HTTP_TLS_KEY=/certs/domain.key \
  -v /home/forgejo/registry/auth:/auth \
  -v /home/forgejo/registry/certs:/certs \
  -v /home/forgejo/registry/data:/var/lib/registry \
  --restart always \
  registry:2

# Verifikasi
docker login 192.168.2.5:5000 -u Group-1 -p kelargacor
curl -k https://192.168.2.5:5000/v2/_catalog -u Group-1:kelargacor
```

## 1.4 Forgejo Actions Runner

```bash
wget https://code.forgejo.org/forgejo/runner/releases/download/v3.5.0/forgejo-runner-3.5.0-linux-amd64
chmod +x forgejo-runner-3.5.0-linux-amd64
sudo mv forgejo-runner-3.5.0-linux-amd64 /usr/local/bin/forgejo-runner

# Ambil token dari Forgejo: Site Administration -> Actions -> Runners
forgejo-runner register --instance http://192.168.2.5:3000 \
  --token <TOKEN> --name runner-1 --no-interactive

# Generate config, edit supaya bisa akses Docker daemon host
forgejo-runner generate-config > /home/forgejo/config.yml
# Edit config.yml bagian container:
#   container:
#     valid_volumes:
#       - /var/run/docker.sock
# (JANGAN tambah baris options: manual -> bikin duplicate mount, lihat error di bawah)

# Jalankan (sementara pakai nohup; untuk produksi pakai systemd)
cd /home/forgejo
nohup forgejo-runner daemon -c config.yml > runner.log 2>&1 &
```

### Runner sebagai systemd (lebih baik, auto-restart)
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
```

---

# BAGIAN 2 — REPOSITORY

```bash
# 1. Fork https://github.com/KenHoH/ComMX ke akun GitHub pribadi (lewat web)
# 2. Clone hasil fork
git clone https://github.com/<username>/ComMX.git
cd ComMX
git checkout -b dev && git push origin dev
git checkout main
# 3. Push ke Forgejo lokal (buat repo dulu di Forgejo)
git remote add forgejo http://192.168.2.5:3000/prk/tpaonsite.git
git push forgejo main
git push forgejo dev
```

`.env` dan file berisi credential JANGAN ke-push (masuk `.gitignore`).

---

# BAGIAN 3 — DOCKERFILE

## backend/Dockerfile (NestJS)
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
CMD ["node", "dist/src/main"]   # PENTING: dist/src/main, bukan dist/main
```
Port backend diambil dari env `PORT` (`process.env.PORT!`, wajib diisi).

## frontend/Dockerfile (Next.js, output: standalone)
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
**Kunci:** `NEXT_PUBLIC_*` di-BAKE saat build (build-time), TIDAK bisa lewat Secret Kubernetes.
Kalau nilainya salah, harus rebuild image, bukan restart pod.

---

# BAGIAN 4 — WORKFLOW CI (.forgejo/workflows/ci.yml)

```yaml
name: CI-CD
on:
  push:
    branches: [main]

jobs:
  ci:
    runs-on: docker
    container:
      image: node:20-bullseye        # butuh Node (untuk actions/checkout) + docker cli diinstall manual
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
          echo "kelargacor" | docker login 192.168.2.5:5000 -u Group-1 --password-stdin
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

Buat `CI_TOKEN` di Forgejo: Settings -> Applications -> Generate Token (scope write:repository),
lalu simpan di Repo Settings -> Actions -> Secrets.

---

# BAGIAN 5 — KUBERNETES MANIFEST (folder k8s/)

Struktur: namespace, backend/, frontend/, config/ (configmap+secret), postgres/, redis/,
gateway/ (gateway+httproute+metallb), policies/ (kyverno+networkpolicy), argocd/, kustomization.yaml

## Poin penting per file:

**config/configmap.yaml** — `PORT: "3000"` (bukan BACKEND_PORT), NODE_ENV, REDIS_HOST, REDIS_PORT.

**config/secret.yaml** (JANGAN commit, di-gitignore):
```yaml
stringData:
  POSTGRES_USER: "user_db"
  POSTGRES_PASSWORD: "pass_db"
  POSTGRES_DB: "commx_db"
  DATABASE_URL: "postgresql://user_db:pass_db@postgres.commx.svc.cluster.local:5432/commx_db"
  JWT_SECRET: "<random-string>"
  SOCKET_ORIGIN: "https://commx.local.com"   # huruf kecil semua (CORS case-sensitive!)
  REDIS_URL: "redis://redis:6379"
```

**backend & frontend deployment** — port 3000, label `app` + `owner` + `app.kubernetes.io/name`
(untuk Kyverno), `imagePullSecrets: registry-credentials`.

**redis/statefulset.yaml** — perlu `fsGroup: 999` + initContainer chown + `runAsUser: 999`
(lihat error Redis di bawah).

**postgres/statefulset.yaml** — `storageClassName: "longhorn"`, env `PGDATA: /var/lib/postgresql/data/pgdata`
(lihat error lost+found di bawah).

**gateway/httproute.yaml** — 3 rule: /api (dengan URLRewrite strip prefix), /socket.io, / (frontend):
```yaml
rules:
  - matches: [{path: {type: PathPrefix, value: /api}}]
    filters:
      - type: URLRewrite
        urlRewrite:
          path: {type: ReplacePrefixMatch, replacePrefixMatch: /}
    backendRefs: [{name: backend, port: 3000}]
  - matches: [{path: {type: PathPrefix, value: /socket.io}}]
    backendRefs: [{name: backend, port: 3000}]
  - matches: [{path: {type: PathPrefix, value: /}}]
    backendRefs: [{name: frontend, port: 3000}]
```

**policies/kyverno-policies.yaml** — 3 policy: disallow-latest-tag, disallow-default-namespace,
require-app-label (dengan `exclude` untuk `cilium-gateway-*`).

---

# BAGIAN 6 — DEPLOY KE CLUSTER

```bash
# Akses cluster dari VM Forgejo (kubeconfig dari temen / control plane)
mkdir -p /root/.kube
# copy isi /etc/kubernetes/admin.conf dari CP ke /root/.kube/config
kubectl get nodes   # pastikan semua Ready

# Secret registry (untuk pull image dari registry private)
kubectl create secret docker-registry registry-credentials \
  --docker-server=192.168.2.5:5000 \
  --docker-username=Group-1 \
  --docker-password=kelargacor \
  -n commx

# Secret database
kubectl apply -f k8s/config/secret.yaml

# Secret TLS Gateway
kubectl create secret tls commx-tls-cert \
  --cert=/tmp/tls.crt --key=/tmp/tls.key -n commx

# Prasyarat CRD (kalau belum ada)
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.1.0/standard-install.yaml
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.1.0/experimental-install.yaml   # butuh tlsroutes untuk Cilium

# Install ArgoCD Application
kubectl apply -f k8s/argocd/application.yaml
kubectl get application commx-app -n argocd
```

## Setup TLS di TIAP node k8s (6 node) — supaya bisa pull dari registry
```bash
sudo mkdir -p /etc/containerd/certs.d/192.168.2.5:5000
# copy domain.crt jadi ca.crt di path itu
sudo tee /etc/containerd/certs.d/192.168.2.5:5000/hosts.toml <<'EOF'
server = "https://192.168.2.5:5000"
[host."https://192.168.2.5:5000"]
  capabilities = ["pull", "resolve"]
  ca = ["/etc/containerd/certs.d/192.168.2.5:5000/ca.crt"]
EOF
# atau install cert sebagai trusted CA sistem:
sudo cp ca.crt /usr/local/share/ca-certificates/registry.crt
sudo update-ca-certificates
sudo systemctl restart containerd
```

## Enable Gateway API di Cilium
```bash
# di control plane
helm get values cilium -n kube-system -o yaml > cilium-values.yaml
# tambahkan: gatewayAPI: {enabled: true}
helm upgrade cilium cilium/cilium -n kube-system --version 1.16.5 -f cilium-values.yaml
kubectl rollout restart deployment cilium-operator -n kube-system
kubectl rollout restart daemonset cilium -n kube-system
kubectl get gatewayclass   # tunggu ACCEPTED: True
```

## Setup DNS di MikroTik
```
/ip dns set servers=10.22.64.21,10.22.64.22 allow-remote-requests=yes
/ip dns static add name=ComMX.local.com address=192.168.3.203
```
Pastikan PC klien pakai MikroTik (10.22.103.201) sebagai DNS server.

## Init database (Drizzle tidak auto-migrate)
```bash
kubectl exec -n commx postgres-0 -- psql -U user_db -d commx_db -c \
  "CREATE TABLE IF NOT EXISTS users (id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, username VARCHAR(255) NOT NULL, password VARCHAR(255) NOT NULL);"
```

---

# BAGIAN 7 — DAFTAR ERROR & SOLUSI

Ini semua error yang muncul saat pengerjaan, urut kejadian. Hafalkan pola & sebabnya.

### E1. `docker: command not found` di pipeline
**Sebab:** container job (`node:20-bullseye`) tidak punya Docker CLI.
**Solusi:** tambah step `apt-get update && apt-get install -y docker.io` sebelum step yang pakai docker.

### E2. `Duplicate mount point: /var/run/docker.sock`
**Sebab:** docker.sock di-mount 2x — dari `options:` manual DAN `valid_volumes:` default.
**Solusi:** di config.yml runner, hapus baris `options:`, cukup `valid_volumes:`.

### E3. `exec: "node": executable file not found`
**Sebab:** sempat ganti base image ke `docker:24-cli` yang tidak punya Node (dibutuhkan actions/checkout).
**Solusi:** balik ke `node:20-bullseye`, install docker.io di dalamnya.

### E4. `database or disk is full` (Forgejo error 500)
**Sebab:** disk VM 9.8GB penuh oleh image + build cache + Trivy DB.
**Solusi:** `docker builder prune -a -f`, `docker image prune -a -f`. Permanen: resize disk VM.
```bash
# resize disk LVM setelah expand di hypervisor:
sudo growpart /dev/sda 3
sudo pvresize /dev/sda3
sudo lvextend -l +100%FREE /dev/mapper/ubuntu--vg-ubuntu--lv
sudo resize2fs /dev/mapper/ubuntu--vg-ubuntu--lv
```

### E5. Trivy `no space left on device`
**Sebab:** Trivy download DB vulnerability 110MB tiap run.
**Solusi:** tambah volume cache `-v trivy-cache:/root/.cache/trivy` di step Trivy.

### E6. Runner status "Waiting" / offline setelah VM restart
**Sebab:** runner pakai nohup, mati saat VM reboot.
**Solusi:** jalankan ulang `nohup forgejo-runner daemon -c config.yml`, atau pakai systemd.

### E7. Trivy Image Scan gagal — `no healthy / unable to find image`
**Sebab:** Trivy di dalam container tidak bisa akses Docker daemon host.
**Solusi:** tambah `-v /var/run/docker.sock:/var/run/docker.sock` di step Trivy Image.

### E8. Manifest storageClassName salah (`postgres Pending`)
**Sebab:** PVC minta StorageClass `local-path`, cluster hanya punya `longhorn`.
**Solusi:** ganti jadi `storageClassName: "longhorn"`. PVC lama immutable -> hapus StatefulSet + PVC, biar dibuat ulang.

### E9. Backend `Cannot find module '/app/dist/main'`
**Sebab:** output NestJS ada di `dist/src/main.js`, bukan `dist/main.js`.
**Solusi:** Dockerfile `CMD ["node", "dist/src/main"]`.

### E10. Redis `chown: Operation not permitted` (CrashLoopBackOff)
**Sebab:** `capabilities: drop: [ALL]` mencabut CAP_CHOWN; Longhorn volume punya lost+found milik root.
**Solusi:** tambah di StatefulSet: `fsGroup: 999` + initContainer busybox `chown -R 999:999 /data` (runAsUser 0) + container `runAsUser: 999`.

### E11. Redis `failed switching to "redis": operation not permitted`
**Sebab:** image redis coba switch user internal, tapi capabilities dicabut.
**Solusi:** jalankan container langsung sebagai `runAsUser: 999` (jangan biarkan switch sendiri).

### E12. Postgres `directory exists but is not empty ... lost+found`
**Sebab:** Postgres tolak init di root mount point yang ada folder lost+found.
**Solusi:** env `PGDATA: /var/lib/postgresql/data/pgdata` (subfolder).

### E13. Backend `MODULE_NOT_FOUND` padahal sudah fix
**Sebab:** manifest masih pakai image tag lama; ArgoCD belum sync.
**Solusi:** pastikan pipeline sukses, ArgoCD sync ke revisi terbaru, atau `kubectl apply` manual.

### E14. Backend `JwtStrategy requires a secret or key`
**Sebab:** env `JWT_SECRET` belum ada di Secret.
**Solusi:** tambah `JWT_SECRET` di secret.yaml, `kubectl apply`, restart pod.

### E15. Backend `ECONNREFUSED 127.0.0.1:6379` (Redis)
**Sebab:** `REDIS_URL` belum diset, kode fallback ke localhost.
**Solusi:** tambah `REDIS_URL: "redis://redis:6379"` di secret.yaml.

### E16. YAML `MalformedYAMLError / did not find expected key`
**Sebab:** salah indentasi (spec 5 spasi), atau CRLF line ending, atau label ditaruh di luar `labels:`.
**Solusi:** perbaiki indentasi, `dos2unix file.yaml`, validasi `python3 -c "import yaml; yaml.safe_load(open('file'))"`.

### E17. Image `http: server gave HTTP response to HTTPS client` (di node k8s)
**Sebab:** containerd node paksa HTTPS, registry masih HTTP.
**Solusi (yang dipakai):** pasang TLS di registry + distribusi ca.crt ke tiap node (lihat Bagian 6).
Alternatif HTTP: `hosts.toml` dengan `skip_verify` — tapi buggy di containerd v2.2.1.

### E18. `x509: certificate signed by unknown authority`
**Sebab:** ca.crt registry belum dipercaya node.
**Solusi:** `cp ca.crt /usr/local/share/ca-certificates/ && update-ca-certificates && systemctl restart containerd`.

### E19. Node NotReady + apiserver crash-loop setelah restart Cilium
**Sebab:** restart Cilium (CNI) bikin networking goyang; kubelet berhenti lapor status.
**Solusi:** `sudo systemctl restart containerd && sudo systemctl restart kubelet` di node terdampak.
**Pelajaran:** hati-hati restart CNI — dampaknya ke seluruh cluster.

### E20. Kyverno webhook `operation not permitted` / admission-controller 0/1
**Sebab:** efek samping restart Cilium; koneksi ke ClusterIP webhook terputus sementara.
**Solusi:** tunggu Cilium & node stabil, Kyverno pod balik Running sendiri.

### E21. GatewayClass ACCEPTED: Unknown / `tlsroutes CRD not found`
**Sebab:** Cilium Gateway API butuh 6 CRD; standard-install hanya 5 (kurang tlsroutes).
**Solusi:** `kubectl apply -f .../gateway-api/.../experimental-install.yaml`.

### E22. Gateway `Unable to create Service ... blocked by Kyverno`
**Sebab:** Service auto-generate Cilium (`cilium-gateway-*`) tidak punya label wajib.
**Solusi:** tambah `exclude: names: ["cilium-gateway-*"]` di policy require-app-label.

### E23. Gateway `Invalid CertificateRef`
**Sebab:** Secret `commx-tls-cert` yang dirujuk Gateway belum dibuat.
**Solusi:** `kubectl create secret tls commx-tls-cert --cert=... --key=... -n commx`.

### E24. `no healthy upstream` saat curl ke Gateway
**Sebab:** Envoy config (CiliumEnvoyConfig) masih pakai port lama (80 bukan 3000).
**Solusi:** perbaiki port di httproute, `kubectl delete ciliumenvoyconfig cilium-gateway-commx-gateway -n commx`, restart cilium-operator.

### E25. Login 404 `Cannot POST /api/auth/login`
**Sebab:** frontend panggil /api/auth/login, backend route cuma /auth/login (prefix /api tidak dihapus).
**Solusi:** URLRewrite ReplacePrefixMatch di HTTPRoute rule /api.

### E26. Login `connection timeout` ke backend
**Sebab:** NetworkPolicy commx-backend-isolation blokir trafik dari Envoy.
**Solusi:** hapus commx-backend-isolation (tetap pertahankan commx-database-isolation).

### E27. Chat `Could not reach the chat server` / socket `Invalid namespace`
**Sebab:** `NEXT_PUBLIC_SOCKET_URL=wss://ComMX.local.com/frontend` -> socket.io anggap /frontend sebagai namespace.
**Solusi:** ubah jadi `wss://ComMX.local.com` (tanpa /frontend) di ci.yml, rebuild image.

### E28. Chat gagal walau socket URL sudah benar
**Sebab:** CORS — `SOCKET_ORIGIN=https://ComMX.local.com` (huruf besar) vs browser akses `commx.local.com` (kecil). CORS case-sensitive.
**Solusi:** samakan huruf kecil: `SOCKET_ORIGIN=https://commx.local.com`.

### E29. Pod pakai image tag lama walau sudah push
**Sebab:** ArgoCD selfHeal dimatikan / belum sync.
**Solusi:** nyalakan selfHeal, `kubectl patch ... sync revision HEAD`, atau `kubectl apply -f` manual.

### E30. Frontend `Failed to fetch` di PC lain
**Sebab:** sertifikat self-signed belum dipercaya browser PC itu, ATAU DNS PC salah.
**Solusi:** akses https://commx.local.com/api/auth/profile sekali, Advanced -> Proceed. Pastikan DNS PC = MikroTik.

---

# BAGIAN 8 — VERIFIKASI AKHIR

```bash
kubectl get pods -n commx          # semua 1/1 Running
kubectl get application commx-app -n argocd   # Synced / Healthy
kubectl get gateway commx-gateway -n commx    # PROGRAMMED True, ada ADDRESS

# test login lewat Gateway
curl -k -X POST -H "Host: commx.local.com" -H "Content-Type: application/json" \
  -d '{"username":"ada","password":"ada"}' https://192.168.3.203/api/auth/login
# -> {"token":"eyJ..."}

# akses browser: https://commx.local.com/frontend (basePath /frontend)
```

---

# BAGIAN 9 — JAWABAN KONSEP (General Knowledge)

- **DevOps**: menyatukan Development + Operations untuk rilis cepat & otomatis.
- **DevSecOps**: DevOps + security di tiap tahap (shift-left) = GitLeaks, Semgrep, Trivy, Checkov.
- **GitOps**: Git jadi sumber kebenaran; ArgoCD sinkronkan cluster ke isi Git otomatis.
- **Runner**: agen yang mengeksekusi step pipeline di mesin nyata (bukan di server Git).
- **CI vs CD**: CI = integrasi + scan + build otomatis; CD = deploy otomatis (Deployment=langsung prod, Delivery=butuh approval).
- **Kenapa NEXT_PUBLIC lewat build-arg bukan Secret**: nilai di-bake ke JS bundle saat build, tidak dibaca runtime.
- **Kenapa Registry perlu TLS di tiap node**: containerd tiap node butuh percaya cert untuk pull image.
- **Kenapa commit SHA sebagai tag**: immutable & unik per commit, mudah trace & rollback, penuhi Kyverno disallow-latest.
- **Deployment strategy dipakai**: RollingUpdate (maxSurge 1, maxUnavailable 0) = zero-downtime.
```

## 1. Siapkan akses `kubectl`

```bash
export KUBECONFIG=/etc/kubernetes/admin.conf
kubectl get nodes -o wide
```

Jika memakai user biasa:

```bash
mkdir -p ~/.kube
sudo cp /etc/kubernetes/admin.conf ~/.kube/config
sudo chown $USER:$USER ~/.kube/config
```

Pastikan semua node:

```text
Ready
```

Cek komponen cluster:

```bash
kubectl get pods -A
kubectl get storageclass
kubectl get gatewayclass
```

## 2. Pastikan Cilium aktif

```bash
kubectl get pods -n kube-system | grep cilium
kubectl -n kube-system rollout status daemonset/cilium
```

Jika Cilium belum dipasang, pasang menggunakan metode dan versi yang sudah disepakati tim. Jangan memasang Cilium di atas CNI lain.

## 3. Pasang komponen jaringan eksternal

Urutannya:

```text
MetalLB → Gateway API controller → GatewayClass
```

Setelah instalasi, cek:

```bash
kubectl get pods -n metallb-system
kubectl get ipaddresspools,l2advertisements -n metallb-system
kubectl get gatewayclass
```

IP pada `IPAddressPool` harus berasal dari rentang jaringan yang memang disediakan untuk cluster. Jangan menggunakan IP milik PC, router, atau node lain.

## 4. Buat Secret aplikasi

Buat Secret dari file lokal:

```bash
kubectl apply -f k8s/config/secret.yaml
```

Pastikan file ini tidak di-commit ke Git.

Cek tanpa menampilkan isi password:

```bash
kubectl get secret commx-secret -n commx
kubectl get secret registry-credentials -n commx
```

Jika private registry belum dibuat Secret-nya:

```bash
kubectl create secret docker-registry registry-credentials \
  --namespace commx \
  --docker-server=<REGISTRY_HOST> \
  --docker-username=<REGISTRY_USER> \
  --docker-password='<REGISTRY_PASSWORD>'
```

Ganti:

```text
<REGISTRY_HOST>
<REGISTRY_USER>
<REGISTRY_PASSWORD>
```

## 5. Terapkan manifest dasar

Jika memakai `kustomization.yaml`:

```bash
kubectl apply -k k8s/
```

Namun bila ingin memastikan dependency berjalan berurutan:

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/config/configmap.yaml
kubectl apply -f k8s/postgres/
kubectl apply -f k8s/redis/
```

Tunggu PostgreSQL dan Redis:

```bash
kubectl get pods -n commx -w
```

Lanjutkan hanya jika keduanya `Running` dan `Ready`.

## 6. Deploy backend dan frontend

```bash
kubectl apply -f k8s/backend/
kubectl apply -f k8s/frontend/
```

Cek:

```bash
kubectl get deployment,pod,svc -n commx
kubectl rollout status deployment/backend -n commx
kubectl rollout status deployment/frontend -n commx
```

Jika backend gagal:

```bash
kubectl logs -n commx deployment/backend
kubectl describe pod -n commx -l app.kubernetes.io/name=backend
```

Periksa terutama:

```text
DATABASE_URL
REDIS_HOST
REDIS_PORT
nama image
port container
imagePullSecrets
```

## 7. Jalankan migration Drizzle

Jalankan migration **satu kali**, bukan dari setiap replica backend.

Cara persisnya mengikuti script di `package.json`. Contoh bentuk perintah:

```bash
kubectl create job drizzle-migrate \
  --from=deployment/backend \
  -n commx
```

Kemudian cek:

```bash
kubectl logs -n commx job/drizzle-migrate
kubectl get job -n commx
```

Nama script migration harus disesuaikan dengan project. Jangan menjalankan contoh tersebut jika Deployment backend belum memiliki command migration yang benar.

## 8. Terapkan Gateway dan HTTPRoute

Setelah Service backend dan frontend memiliki endpoint:

```bash
kubectl get endpoints -n commx
```

terapkan:

```bash
kubectl apply -f k8s/gateway/
```

Cek:

```bash
kubectl get gateway,httproute -n commx
kubectl describe gateway commx-gateway -n commx
kubectl describe httproute commx-route -n commx
```

Pastikan:

```text
GatewayClass tersedia
nama Gateway sesuai parentRefs
nama Service sesuai backendRefs
port Service sesuai HTTPRoute
```

## 9. Terapkan Kyverno dan policy

Kyverno harus sudah terpasang lebih dahulu:

```bash
kubectl get pods -n kyverno
kubectl get crd clusterpolicies.kyverno.io
```

Lalu:

```bash
kubectl apply -f k8s/policies/kyverno-policies.yaml
kubectl get clusterpolicy
kubectl describe clusterpolicy
```

Jika policy langsung memblokir resource yang sudah dibuat, cek event:

```bash
kubectl get events -n commx --sort-by=.lastTimestamp
```

Pastikan semua Deployment, Service, dan StatefulSet memiliki label wajib serta image bertag versi.

## 10. Aktifkan HPA

Pastikan Metrics Server tersedia:

```bash
kubectl get deployment metrics-server -n kube-system
kubectl top nodes
kubectl top pods -n commx
```

Jika `kubectl top` sudah menampilkan data:

```bash
kubectl apply -f k8s/backend/hpa.yaml
kubectl apply -f k8s/frontend/hpa.yaml
kubectl get hpa -n commx
```

Jika `kubectl top` gagal, HPA belum dapat bekerja.

## 11. Validasi akhir

```bash
kubectl get nodes
kubectl get pods -A
kubectl get all -n commx
kubectl get pvc -n commx
kubectl get gateway,httproute -n commx
kubectl get hpa -n commx
kubectl get clusterpolicy
```

Validasi rollout:

```bash
kubectl rollout status statefulset/postgres -n commx
kubectl rollout status statefulset/redis -n commx
kubectl rollout status deployment/backend -n commx
kubectl rollout status deployment/frontend -n commx
```

Jika aplikasi belum dapat diakses, periksa dari bawah ke atas:

```text
Pod → Service selector → Endpoints → Gateway → MetalLB IP → DNS
```

Jangan lanjut ke ArgoCD dan CI/CD sebelum aplikasi dapat berjalan manual dengan urutan:

```text
PostgreSQL Ready
Redis Ready
Backend Ready
Frontend Ready
Service memiliki Endpoints
Gateway memiliki alamat IP
HTTPRoute Accepted
```

Setelah tahap manual ini berhasil, baru ArgoCD digunakan untuk mengambil manifest dari repository dan melakukan sinkronisasi otomatis.
# BAGIAN A — LANGKAH FORK & CLONE DARI AWAL

## A.1 Fork repo soal (WAJIB, dinilai)
Soal kasih repo template: `https://github.com/KenHoH/ComMX`
1. Buka repo itu di browser, login GitHub pribadi.
2. Klik **Fork** (kanan atas) -> pilih akun kamu.
3. Sekarang ada `https://github.com/<username-kamu>/ComMX`.

> Fork WAJIB dari repo soal, BUKAN dari repo hasil kerjamu. Yang dinilai adalah
> kamu fork template resmi lalu mengembangkannya.

## A.2 Ambil hasil kerjamu (repo yang sudah jadi)
Kamu punya backup repo jadi di GitHub pribadi (hasil push kemarin). Dua opsi:

**Opsi 1 — mulai dari fork template, tambahkan file hasil kerja:**
```bash
git clone https://github.com/<username>/ComMX.git
cd ComMX
# lalu salin file hasil kerjamu (Dockerfile, k8s/, .forgejo/) ke sini
```

**Opsi 2 — clone langsung repo jadi (lebih cepat), lalu perbaiki nilai:**
```bash
git clone https://github.com/<username>/repo-jadi.git ComMX
cd ComMX
```

Opsi 2 lebih cepat, TAPI wajib ganti semua nilai lama (Bagian B).
Apa pun opsinya, hasil akhir tetap harus ada fork template di GitHub (poin soal).

## A.3 Push ke Forgejo lokal (setelah Forgejo hidup — lihat panduan utama Bagian 4)
```bash
cd ComMX
git remote add forgejo http://<IP-FORGEJO-BARU>:3000/<owner>/<repo>.git
git push forgejo main
git push forgejo dev    # kalau belum ada branch dev: git checkout -b dev dulu
```

---

# BAGIAN B — SEMUA NILAI YANG HARUS DICARI-GANTI

Repo lama menyimpan nilai environment latihan. Kalau ujian pakai IP/nama beda,
SEMUA ini harus diganti. Cari dulu semua kemunculannya:

```bash
cd ComMX
grep -rn "192.168.2.5\|192.168.1.\|192.168.3.\|10.22\|tpaonsite\|prk\|ComMX.local\|commx.local\|Group-1\|group-2\|ad3abf7" \
  --include="*.yml" --include="*.yaml" . | grep -v node_modules
```

## Tabel nilai yang menempel di repo (per file)

| File | Nilai lama | Ganti ke | Kritikal? |
|------|-----------|----------|-----------|
| `.forgejo/workflows/ci.yml` | IP registry `192.168.2.5:5000` | IP registry baru | YA |
| `.forgejo/workflows/ci.yml` | `-u Group-1` | username grup kamu | YA |
| `.forgejo/workflows/ci.yml` | path `group-2/commx-*` | path grup kamu | YA |
| `.forgejo/workflows/ci.yml` | `NEXT_PUBLIC_*=...ComMX.local.com` | domain baru | YA |
| `.forgejo/workflows/ci.yml` | `git push ...@192.168.2.5:3000/prk/tpaonsite.git` | IP+owner+repo Forgejo baru | YA |
| `k8s/argocd/application.yaml` | `repoURL: ...192.168.2.5:3000/prk/tpaonsite.git` | IP+owner+repo baru | YA |
| `k8s/backend/deployment.yaml` | `image: 192.168.2.5:5000/group-2/commx-backend:<tag>` | IP+path baru | YA |
| `k8s/frontend/deployment.yaml` | `image: 192.168.2.5:5000/group-2/commx-frontend:<tag>` | IP+path baru | YA |
| `k8s/gateway/httproute.yaml` | hostname `commx.local.com` | domain baru | YA |
| `k8s/gateway/metallb.yaml` | pool `192.168.1.200-220` | pool subnet node-speaker | YA (& salah!) |
| `k8s/config/secret.yaml` | DB url, SOCKET_ORIGIN domain | sesuaikan | YA |
| `k8s/config/configmap.yaml` | REDIS_HOST dll | biasanya tetap | cek |

## Cara ganti massal (kalau IP berubah, contoh)
```bash
# ganti IP registry/forgejo lama -> baru (sesuaikan IP)
grep -rl "192.168.2.5" --include="*.yml" --include="*.yaml" . | grep -v node_modules \
  | xargs sed -i 's/192\.168\.2\.5/<IP-BARU>/g'

# ganti username registry
sed -i 's/-u Group-1/-u <GRUP-KAMU>/' .forgejo/workflows/ci.yml

# ganti path image (kalau nomor grup beda)
grep -rl "group-2/commx" --include="*.yml" --include="*.yaml" . | grep -v node_modules \
  | xargs sed -i 's|group-2/commx|<grup-kamu>/commx|g'

# ganti nama repo/owner di ci.yml & argocd
sed -i 's|prk/tpaonsite|<owner>/<repo>|g' .forgejo/workflows/ci.yml k8s/argocd/application.yaml

# ganti domain (kalau beda)
grep -rl "ComMX.local.com\|commx.local.com" --include="*.yml" --include="*.yaml" . | grep -v node_modules \
  | xargs sed -i 's/ComMX.local.com/<DOMAIN-BARU>/g; s/commx.local.com/<domain-baru>/g'
```

## metallb.yaml — WAJIB perbaiki (bukan cuma ganti IP)
File repo tulis `192.168.1.200-220` yang SALAH (subnet bukan node-speaker).
Ganti ke pool di subnet yang sama dengan node MetalLB speaker. Kalau pakai Ansible,
lebih baik HAPUS file ini dari repo (Ansible sudah bikin pool sendiri yang benar).

---

# BAGIAN C — YANG TIDAK ADA DI REPO, HARUS DIBUAT ULANG SAAT UJIAN

Ini file/secret yang sengaja TIDAK di repo (rahasia). Harus dibuat baru:

## C.1 CI_TOKEN (untuk workflow push balik ke Forgejo)
Workflow pakai `${{ secrets.CI_TOKEN }}`. Token ini TIDAK ikut di repo — harus
dibuat baru di Forgejo yang baru:
1. Forgejo -> klik avatar -> **Settings -> Applications**
2. **Generate New Token**, nama bebas, scope centang **write:repository** (+ read)
3. Copy token.
4. Repo di Forgejo -> **Settings -> Actions -> Secrets** -> **Add Secret**
   - Name: `CI_TOKEN`
   - Value: token tadi
Tanpa ini, step "Update K8s Manifest" gagal push (pipeline error di akhir).

## C.2 secret.yaml (credential DB) — gitignored, tidak ada di repo
Buat manual dari `secret.example.yaml`:
```bash
cp k8s/config/secret.example.yaml k8s/config/secret.yaml
nano k8s/config/secret.yaml
```
Isi (sesuaikan domain, SOCKET_ORIGIN HURUF KECIL):
```yaml
stringData:
  POSTGRES_USER: "user_db"
  POSTGRES_PASSWORD: "pass_db"
  POSTGRES_DB: "commx_db"
  DATABASE_URL: "postgresql://user_db:pass_db@postgres.commx.svc.cluster.local:5432/commx_db"
  JWT_SECRET: "<string-acak-panjang>"
  SOCKET_ORIGIN: "https://<domain-baru>"   # huruf kecil
  REDIS_URL: "redis://redis:6379"
```

## C.3 Cert registry + htpasswd + secret registry
Semua digenerate ulang (lihat panduan utama Bagian 4.4 & 9.2), pakai username grup kamu.

## C.4 kubeconfig
Ambil dari control plane baru (`/etc/kubernetes/admin.conf`) -> `~/.kube/config`.

---

# BAGIAN D — MASALAH GIT HISTORY (penting untuk GitHub)

`secret.yaml` sudah dihapus dari commit terbaru & sudah gitignore. TAPI di history
git lama (commit `4d314df`) file itu PERNAH ke-commit berisi password DB.

Kalau kamu push repo ini ke GitHub:
- **Solusi cepat & aman:** buat repo GitHub **PRIVATE**. Password cuma untuk lab,
  bukan production. Ini cukup untuk ujian.
- **Solusi bersih (kalau sempat):** mulai repo baru tanpa history lama:
  ```bash
  cd ComMX
  rm -rf .git
  git init
  git add .
  git commit -m "initial commit (clean history)"
  git branch -M main
  git remote add origin https://github.com/<username>/ComMX.git
  git push -u origin main --force
  ```
  Ini menghapus SEMUA history (termasuk yang bocor). Pastikan `secret.yaml` sudah
  di-gitignore SEBELUM `git add .`.

> Soal eksplisit: "Don't push any credentials to GitHub." Jadi minimal repo PRIVATE,
> idealnya history bersih.

---

# BAGIAN E — URUTAN SAAT UJIAN (ringkas)

1. **Fork** template soal ke GitHub (A.1)
2. Setup VM Forgejo: disk, Docker, Forgejo, Registry(TLS,username grup), Runner systemd
   (panduan utama Bagian 3-4)
3. Clone repo (dari fork/hasil kerja) ke VM
4. **Ganti semua nilai environment** (Bagian B) sesuai IP/domain/grup ujian
5. Buat `secret.yaml` (C.2), CI_TOKEN (C.1)
6. Push ke Forgejo -> pipeline jalan
7. Setup cluster: kubeconfig, secret, Gateway CRD, Cilium GW, cert ke node, ArgoCD
   (panduan utama Bagian 9) — ATAU jalankan Ansible (K2Help)
8. Kyverno PALING AKHIR
9. Init DB, DNS MikroTik
10. Verifikasi: pod Running, login browser

---

# BAGIAN F — CHECKLIST CEPAT "APA YANG BEDA SAAT UJIAN"

- [ ] IP Forgejo/Registry (ganti 192.168.2.5 di semua file)
- [ ] IP/subnet MetalLB pool (sesuai node-speaker, perbaiki metallb.yaml)
- [ ] Nama repo & owner Forgejo (ganti prk/tpaonsite)
- [ ] Username registry (Group-1 -> grup kamu)
- [ ] Path image (group-2 -> grup kamu, konsisten ci.yml + 2 deployment)
- [ ] Domain (ComMX.local.com -> domain ujian)
- [ ] SOCKET_ORIGIN huruf kecil
- [ ] CI_TOKEN baru di Forgejo Secrets
- [ ] secret.yaml dibuat baru (gitignored)
- [ ] repoURL argocd/application.yaml
- [ ] kubeconfig dari CP baru
- [ ] Repo GitHub PRIVATE (history ada secret lama)
```

const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL!.replace(/\/$/, "");

export async function loginUsernameAndPassword(
  username: string,
  password: string,
) {
  const res = await fetch(`${backendUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
    credentials: "include",
  });

  if (!res.ok) throw new Error("Invalid credentials");

  return res.json();
}

"use client";

import { useState } from "react";

interface LoginViewProps {
  onSubmit: (username: string, password: string) => void;
  connecting: boolean;
  error: string | null;
}

export default function LoginView({
  onSubmit,
  connecting,
  error,
}: LoginViewProps) {
  const [value, setValue] = useState("");
  const [password, setPassword] = useState("");
  const trimmed = value.trim();
  const trimmedPassword = password.trim();

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!trimmed || !trimmedPassword || connecting) return;
    onSubmit(trimmed, trimmedPassword);
  }

  return (
    <div className="flex flex-1 items-center justify-center px-4">
      <div className="animate-view-in w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-800">
          Welcome to ComMX
        </h1>
        <p className="mt-2 text-sm text-neutral-500">
          Enter Username and Password to start chatting
        </p>

        <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-3">
          <label htmlFor="username" className="sr-only">
            Username
          </label>
          <input
            id="username"
            type="text"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. ada"
            maxLength={24}
            className="w-full rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-neutral-800 placeholder-neutral-400 outline-none transition focus:border-neutral-400 focus:bg-white"
          />
          <label htmlFor="password" className="sr-only">
           Password
          </label>
          <input
            id="password"
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="e.g. ada"
            maxLength={24}
            className="w-full rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-neutral-800 placeholder-neutral-400 outline-none transition focus:border-neutral-400 focus:bg-white"
          />
          <button
            type="submit"
            disabled={!trimmed || !trimmedPassword || connecting}
            className="w-full rounded-xl bg-neutral-800 px-4 py-3 font-medium text-neutral-50 transition hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {connecting ? "Connecting…" : "Enter"}
          </button>
          {error && (
            <p className="text-center text-sm text-neutral-500">{error}</p>
          )}
        </form>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null);
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [dark, setDark] = useState(true);

  useEffect(() => {
    const saved = localStorage.getItem("theme");
    const isDark = saved ? saved === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    setDark(isDark);
    document.body.classList.toggle("dark-theme", isDark);
  }, []);

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    document.body.classList.toggle("dark-theme", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setAttemptsLeft(null);
    setLoading(true);

    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();

      if (data.success) {
        router.push("/dashboard");
        router.refresh();
      } else {
        setError(data.message || "Login failed");
        if (data.attemptsRemaining !== undefined) setAttemptsLeft(data.attemptsRemaining);
        if (data.locked) {
          setLocked(true);
          setPassword("");
        }
      }
    } catch {
      setError("Login failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button className="theme-switch" onClick={toggleTheme} aria-label="Toggle theme">
        <img src={dark ? "/assets/sun.svg" : "/assets/moon.svg"} alt="" width={24} height={24} />
      </button>

      <div className="login-container">
        <div className="login-card">
          <div className="logo">
            <h1>Nightmare Library</h1>
            <p>Your private digital bookshelf</p>
          </div>

          {error && (
            <div className="error-message">
              {error}
              {attemptsLeft !== null && attemptsLeft > 0 && ` (${attemptsLeft} attempts remaining)`}
            </div>
          )}

          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label htmlFor="password">Password</label>
              <input
                type="password"
                id="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                required
                autoComplete="current-password"
                disabled={locked}
              />
            </div>

            <button type="submit" className="submit-btn" disabled={loading || locked}>
              {loading ? "Entering..." : "Enter Library"}
            </button>
          </form>
        </div>
      </div>
    </>
  );
}

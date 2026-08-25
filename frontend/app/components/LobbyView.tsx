"use client";

interface LobbyViewProps {
  username: string;
  rooms: string[];
  onJoin: (roomId: string) => void;
  onCreate: () => void;
  onRefresh: () => void;
  onLogout: () => void;
}

export default function LobbyView({
  username,
  rooms,
  onJoin,
  onCreate,
  onRefresh,
  onLogout,
}: LobbyViewProps) {
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-8">
      <div className="animate-view-in flex w-full max-w-md flex-col rounded-2xl border border-neutral-200 bg-white shadow-sm">
        <header className="flex items-center justify-between border-b border-neutral-100 px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-neutral-800">
              Rooms
            </h1>
            <p className="text-xs text-neutral-500">
              Signed in as{" "}
              <span className="font-medium text-neutral-700">{username}</span>
            </p>
          </div>
          <button
            onClick={onLogout}
            className="rounded-lg px-3 py-1.5 text-sm text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-700"
          >
            Sign out
          </button>
        </header>

        <div className="flex items-center justify-between px-6 pt-4">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            {rooms.length} available
          </span>
          <button
            onClick={onRefresh}
            className="text-xs text-neutral-500 transition hover:text-neutral-700"
          >
            Refresh
          </button>
        </div>

        <ul className="subtle-scroll max-h-72 min-h-24 overflow-y-auto px-4 py-3">
          {rooms.length === 0 ? (
            <li className="px-2 py-6 text-center text-sm text-neutral-400">
              No active rooms yet. Create one to get started.
            </li>
          ) : (
            rooms.map((roomId) => (
              <li key={roomId}>
                <button
                  onClick={() => onJoin(roomId)}
                  className="group flex w-full items-center justify-between rounded-xl px-3 py-3 text-left transition hover:bg-neutral-50"
                >
                  <span className="flex items-center gap-3">
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-100 text-xs font-semibold text-neutral-500">
                      #
                    </span>
                    <span className="font-medium text-neutral-700">
                      {roomId}
                    </span>
                  </span>
                  <span className="text-sm text-neutral-300 transition group-hover:text-neutral-500">
                    Join →
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>

        <div className="border-t border-neutral-100 p-4">
          <button
            onClick={onCreate}
            className="w-full rounded-xl bg-neutral-800 px-4 py-3 font-medium text-neutral-50 transition hover:bg-neutral-700"
          >
            + Create New Room
          </button>
        </div>
      </div>
    </div>
  );
}

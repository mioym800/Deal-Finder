import { NavLink } from 'react-router-dom';

type Props = { isAdmin?: boolean; onLogout: () => void };

export default function Sidebar({ isAdmin, onLogout }: Props) {
  const base =
    'flex items-center gap-3 px-4 py-2 rounded-xl text-sm transition-colors';
  const idle = 'text-gray-300 hover:text-white hover:bg-white/5';
  const active = 'text-white bg-white/10';

  return (
    <aside className="w-56 shrink-0 h-screen sticky top-0 bg-[#0f1320] border-r border-white/10 p-4">
      <div className="text-lg font-semibold text-white px-2 py-2">Deal Finder</div>
      <nav className="mt-4 flex flex-col gap-1">
        <NavLink to="/" end className={({ isActive }) => `${base} ${isActive ? active : idle}`}>
          <span>Dashboard</span>
        </NavLink>
        <NavLink to="/deals" className={({ isActive }) => `${base} ${isActive ? active : idle}`}>
          <span>Deals</span>
        </NavLink>
        {isAdmin && (
          <NavLink to="/users" className={({ isActive }) => `${base} ${isActive ? active : idle}`}>
            <span>Users</span>
          </NavLink>
        )}
        <NavLink to="/privy-otp" className={({ isActive }) => `${base} ${isActive ? active : idle}`}>
          <span>Privy OTP</span>
        </NavLink>

        <button
          onClick={onLogout}
          className={`${base} ${idle} mt-2 text-left`}
        >
          <span>Logout</span>
        </button>
      </nav>
    </aside>
  );
}
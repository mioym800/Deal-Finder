// src/App.js
import React, { useEffect, useState } from "react";
import Logo from "./assets/logo.png";
import { BrowserRouter, Routes, Route, Navigate, Link, useLocation, Outlet } from "react-router-dom";
import {
  ThemeProvider, createTheme, CssBaseline,
  Box, AppBar, Toolbar, Typography, IconButton, Drawer, List, ListItemIcon, ListItemButton,
  ListItemText, Divider, useMediaQuery
} from "@mui/material";
import MenuIcon from "@mui/icons-material/Menu";

import Deals from "./screens/Deals.tsx";
import Users from "./screens/Users.tsx";
import PrivyOtp from "./screens/PrivyOtp.tsx";
import Dashboard from "./screens/Dashboard.tsx";
import Login from "./components/Login/Login.tsx";
import { verify, clearToken } from "./helpers";
import { ensureNotifPermission } from "./utils/notify.tsx";
import OtpWatcher from './components/OtpWatcher.tsx';


// ---- THEME (deep midnight w/ subtle gradient) ----
const theme = createTheme({
  palette: {
    mode: "dark",
    background: { default: "#ffffff", paper: "#ffffff" },
    primary: { main: "#111111" },
    secondary: { main: "#a78bfa" },
    divider: "rgba(255,255,255,0.08)",
  },
  typography: {
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial",
    button: { textTransform: "none", fontWeight: 600 }
  },
  shape: { borderRadius: 12 },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: "linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,0))",
          border: "1px solid rgba(255,255,255,0.06)"
        }
      }
    },
    MuiTableHead: {
      styleOverrides: { root: { backgroundColor: "rgba(255,255,255,0.05)" } }
    }
  }
});

// ---- AUTH GUARD ----
function Protected({ children }) {
  const authed = Boolean(localStorage.getItem("authToken"));
  return authed ? children : <Navigate to="/login" replace />;
}

// ---- SIDEBAR + LAYOUT ----
const navItems = [
  { label: "Dashboard", to: "/" },
  { label: "Deals", to: "/deals" },
  { label: "Users", to: "/users", adminOnly: true },
  { label: "Privy OTP", to: "/privy-otp" },
];

function Sidebar({ open, onClose, isAdmin, onLogout }) {
  const location = useLocation();
  return (
    <Box sx={{
      width: 240,
      height: "100%",
      background: "lightgray",
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
      justifyContent: "flex-start",
      pt: 4,
      scrollbarWidth: "none",           // Firefox
      msOverflowStyle: "none",          // IE/Edge
      "&::-webkit-scrollbar": {         // Chrome/Safari
        width: 0,
        height: 0,
        display: "none"
      }
    }}>
      <Box sx={{ display: "flex", justifyContent: "center", alignItems: "center", py: 2 }}>
        <img src={Logo} alt="Logo" style={{ maxWidth: "140px", height: "auto" }} />
      </Box>
      <Divider />
      <Box sx={{ flexGrow: 1 }}>
        <List dense sx={{ mt: "auto" }}>
          {navItems
            .filter(n => !n.adminOnly || isAdmin)
            .map(n => {
              const active = location.pathname === n.to;
              return (
                <ListItemButton
                  key={n.to}
                  component={Link}
                  to={n.to}
                  onClick={onClose}
                  selected={active}
                  sx={{
                    my: 0.75,
                    px: 1.25,
                    py: 1.25,
                    borderRadius: 3,
                    color: '#111',
                    transition: 'all .15s ease',
                    border: '1px solid transparent',
                    boxShadow: active ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                    '&:hover': {
                      bgcolor: '#efefef',
                      borderColor: '#e5e5e5',
                      transform: 'translateY(-1px)'
                    },
                    '&.Mui-selected': {
                      bgcolor: '#e9e9e9',
                      borderColor: '#d4d4d4',
                      '&:hover': { bgcolor: '#e5e5e5' }
                    }
                  }}
                >
                  <ListItemIcon sx={{ minWidth: 28 }}>
                    <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: active ? '#111' : '#bdbdbd' }} />
                  </ListItemIcon>
                  <ListItemText
                    primary={n.label}
                    primaryTypographyProps={{
                      fontWeight: active ? 700 : 600,
                      letterSpacing: 0.2,
                      color: '#111'
                    }}
                  />
                </ListItemButton>
              );
            })}
        </List>
      </Box>
      <Box sx={{ flexGrow: 1 }} />
      <Divider />
      <List dense sx={{ mt: 1, mb: 2 }}>
        <ListItemButton
          onClick={() => { onClose && onClose(); onLogout && onLogout(); }}
          sx={{
            my: 0.75,
            px: 1.25,
            py: 1.25,
            borderRadius: 3,
            color: '#111',
            transition: 'all .15s ease',
            border: '1px solid transparent',
            '&:hover': { bgcolor: '#efefef', borderColor: '#e5e5e5', transform: 'translateY(-1px)' }
          }}
        >
          <ListItemIcon sx={{ minWidth: 28 }}>
            <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: '#b91c1c' }} />
          </ListItemIcon>
          <ListItemText primary="Logout" primaryTypographyProps={{ fontWeight: 700, color: '#111' }} />
        </ListItemButton>
      </List>
    </Box>
  );
}

function Shell({ user, onLogout }) {
  const [open, setOpen] = useState(false);
  const isMdUp = useMediaQuery("(min-width:900px)");

  const drawer = (
    <Sidebar
      open={open}
      onClose={() => setOpen(false)}
      isAdmin={Boolean(user?.isAdmin || user?.role === "admin")}
      onLogout={onLogout}
    />
  );

  return (
    <Box sx={{
      minHeight: "100vh",
      background: "#ffffff"
    }}>
      <AppBar elevation={0} position="sticky"
        sx={{ bgcolor: "#ffffff", backdropFilter: "saturate(120%) blur(6px)", borderBottom: "1px solid rgba(255,255,255,.08)" }}>
        <Toolbar>
          {!isMdUp && (
            <IconButton edge="start" color="inherit" onClick={() => setOpen(true)} sx={{ mr: 1 }}>
              <MenuIcon />
            </IconButton>
          )}
          <Typography sx={{ fontWeight: 800, letterSpacing: .2, flex: 1, textAlign: "center", color: "black", fontSize: "2.5rem" }}>MIOYM Deal Finder</Typography>
        </Toolbar>
      </AppBar>

      {/* Sidebar */}
      {isMdUp ? (
        <Drawer variant="permanent" open
          PaperProps={{ sx: {
            width: 240,
            borderRight: "1px solid rgba(255,255,255,.08)",
            bgcolor: "lightgray",
            overflow: "hidden",
            scrollbarWidth: "none",
            msOverflowStyle: "none",
            "&::-webkit-scrollbar": { width: 0, height: 0, display: "none" }
          } }}>
          {drawer}
        </Drawer>
      ) : (
        <Drawer open={open} onClose={() => setOpen(false)}
          PaperProps={{ sx: {
            width: 240,
            bgcolor: "lightgray",
            overflow: "hidden",
            scrollbarWidth: "none",
            msOverflowStyle: "none",
            "&::-webkit-scrollbar": { width: 0, height: 0, display: "none" }
          } }}>
          <Sidebar
            open={open}
            onClose={() => setOpen(false)}
            isAdmin={Boolean(user?.isAdmin || user?.role === "admin")}
            onLogout={onLogout}
          />
        </Drawer>
      )}

      {/* Main content */}
      <Box sx={{ ml: { md: "240px" }, p: 3 }}>
        <Outlet />
      </Box>
    </Box>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [authed, setAuthed] = useState(Boolean(localStorage.getItem("authToken")));

  useEffect(() => {
    try { ensureNotifPermission(); } catch {}
  }, []);

  useEffect(() => {
    if (!authed) return;
    (async () => {
      const v = await verify(); // { success, user }
      if (v?.success) {
        setUser(v.user || null);
      } else {
        localStorage.removeItem("authToken");
        setAuthed(false);
      }
    })();
  }, [authed]);

  const onLogout = () => {
    clearToken();
    setUser(null);
    setAuthed(false);
    window.location.href = "/login";
  };

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <BrowserRouter>
        <OtpWatcher />
        <Routes>
          <Route path="/login" element={<Login verify={() => setAuthed(true)} />} />
          <Route
            path="/"
            element={
              <Protected>
                <Shell user={user} onLogout={onLogout} />
              </Protected>
            }
          >
            <Route index element={<Dashboard />} />
            <Route path="deals" element={<Deals />} />
            <Route path="users" element={
              (user?.isAdmin || user?.role === "admin") ? <Users /> : <Navigate to="/" replace />
            } />
            <Route path="privy-otp" element={<PrivyOtp />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  );
}
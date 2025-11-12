import React, { useEffect, useMemo, useState } from 'react';
import {
  Box, Button, Container, Dialog, DialogActions, DialogContent, DialogTitle,
  TextField, Typography, Chip, IconButton, Table, TableHead, TableRow, TableCell,
  TableBody, Stack, MenuItem, Select, InputLabel, FormControl, OutlinedInput,
  TableContainer, Paper
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import AddIcon from '@mui/icons-material/PersonAdd';
import { getUsers, createUser, updateUser, deleteUser } from '../helpers';
import { STATES } from '../constants.ts';

const BASE = process.env.REACT_APP_API_BASE_URL || 'http://localhost:3015';

const authHeaders = () => {
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  return token ? { Authorization: `Bearer ${token}` } : {};
};

// envelope → flat array
function normalizeUsers(resp: any): any[] {
  const payload = resp?.data ?? resp;
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.users)) return payload.users;
  if (Array.isArray(payload.result)) return payload.result;
  if (Array.isArray(payload.items)) return payload.items;
  return [];
}

// to upper-cased string array
const asStates = (v: any): string[] => {
  if (Array.isArray(v)) return v.map(String).map(s => s.trim().toUpperCase()).filter(Boolean);
  if (typeof v === 'string') return v.split(/[\s,\n]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
  return [];
};

const tableStyles = {
  width: '100%',
  '& th': { background: '#f9fafb', fontWeight: 700, color: 'black' },
  '& td, & th': { borderRight: '1px solid #e5e7eb', borderBottom: '1px solid #e5e7eb', color: 'black' },
};

const fieldBox = {
  background: '#fafafa',
  border: '1px solid #e5e7eb',
  borderRadius: 2,
  p: 1.5,
};

export default function Users(): JSX.Element {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [raw, setRaw] = useState<any>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'subadmin'>('subadmin');
  const [states, setStates] = useState<string[]>([]);
  const [phone, setPhone] = useState('');
  const [userId, setUserId] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const resp = await getUsers();
      setRaw(resp);
      let list = normalizeUsers(resp).map((u: any) => ({ ...u, states: asStates(u.states) }));

      // Fallback with auth header so it doesn't 401
      if (!Array.isArray(list) || list.length === 0) {
        const r = await fetch(`${BASE}/api/user`, {
          credentials: 'include',
          headers: { 'Accept': 'application/json', ...authHeaders() },
        });
        if (r.ok) {
          const j = await r.json();
          setRaw({ helperResp: resp, directResp: j });
          const alt = normalizeUsers(j).map((u: any) => ({ ...u, states: asStates(u.states) }));
          if (alt.length) list = alt;
        } else {
          console.warn('Direct /api/user request failed', r.status);
        }
      }

      setRows(list);
    } catch (e) {
      console.error('Failed to load users', e);
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const resetForm = () => {
    setEditing(null);
    setFullName('');
    setEmail('');
    setPassword('');
    setRole('subadmin');
    setStates([]);
    setPhone('');
    setUserId('');
  };

  const onAdd = () => { resetForm(); setOpen(true); };
  const onEdit = (u: any) => {
    setEditing(u);
    setFullName(u.full_name || u.fullName || '');
    setEmail(u.email || '');
    setPassword('');
    setRole((u.role as 'admin' | 'subadmin') || 'subadmin');
    setStates(asStates(u.states));          // ← prefill
    setPhone(u.phone || '');
    setUserId(u.user_id || u.userId || '');
    setOpen(true);
  };

  const onSave = async () => {
    const normStates = Array.from(new Set(asStates(states)));
    const ensureUserId = (id: string) => {
      const base = (id || fullName || email).trim();
      if (!base) return `user-${Date.now()}`;
      return base.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').slice(0, 40) || `user-${Date.now()}`;
    };

    const payload: any = {
      full_name: fullName,
      email: String(email || '').toLowerCase(),
      role,
      states: normStates,                   // ← send normalized states
      phone: phone || '+1-000-000-0000',
      user_id: ensureUserId(userId),
    };

    if (!editing) {
      const pw = (password || '').trim();
      if (!pw) { alert('Password is required when creating a new user.'); return; }
      payload.password = pw;
    } else if (password.trim()) {
      payload.password = password.trim();
    }

    const resp = editing
      ? await updateUser(editing._id, payload)
      : await createUser(payload);

    if (!resp?.ok) { alert(resp?.error || resp?.message || 'Save failed'); return; }

    setOpen(false);
    await load();
  };

  const onDelete = async (u: any) => {
    if (!window.confirm(`Delete user ${u.email}?`)) return;
    const resp = await deleteUser(u._id);
    if (!resp?.ok) { alert(resp?.error || 'Delete failed'); return; }
    await load();
  };

  const stateOptions = useMemo(() => STATES.map(s => ({ code: s.code, name: s.name })), []);

  return (
    <Container sx={{ mt: 4 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2}>
        <Typography variant="h5" sx={{ color: 'black' }}>Users</Typography>
        <Button startIcon={<AddIcon />} variant="contained" onClick={onAdd}>Add user</Button>
      </Stack>

      {(!loading && rows.length === 0) && (
        <Box sx={{ mb: 2, background: '#fff3cd', border: '1px solid #ffeeba', p: 2, borderRadius: 2, color: '#664d03' }}>
          No users to display.
          <Button size="small" sx={{ ml: 1 }} onClick={() => setShowRaw(s => !s)}>Toggle raw payload</Button>
        </Box>
      )}
      {showRaw && (
        <pre style={{ maxHeight: 260, overflow: 'auto', background: '#0b1021', color: '#d4d4d4', padding: 12, borderRadius: 8, marginBottom: 16 }}>
{JSON.stringify(raw, null, 2)}
        </pre>
      )}

      <TableContainer component={Paper} sx={{ boxShadow: 'none', border: '1px solid #e5e7eb', borderRadius: 2 }}>
        <Table size="small" sx={tableStyles}>
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Email</TableCell>
              <TableCell>Role</TableCell>
              <TableCell>States</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {!loading && rows.map((u: any) => (
              <TableRow key={u._id}>
                <TableCell>{u.full_name || u.fullName || '-'}</TableCell>
                <TableCell>{u.email}</TableCell>
                <TableCell>{u.role}</TableCell>
                <TableCell sx={{ color: 'black' }}>
                  {u.states?.length ? (
                    <Stack direction="row" gap={0.5} flexWrap="wrap">
                      {u.states.map((s: string) => (
                        <Chip
                          key={s}
                          size="small"
                          label={String(s).toUpperCase()}
                          sx={{
                            color: 'black',
                            backgroundColor: '#f3f4f6',
                            border: '1px solid #e5e7eb',
                            fontWeight: 600,
                          }}
                        />
                      ))}
                    </Stack>
                  ) : (<span>—</span>)}
                </TableCell>
                <TableCell align="right">
                  <IconButton onClick={() => onEdit(u)} sx={{ color: 'black' }}>
                    <EditIcon />
                  </IconButton>
                  <IconButton color="error" onClick={() => onDelete(u)}><DeleteIcon /></IconButton>
                </TableCell>
              </TableRow>
            ))}
            {loading && <TableRow><TableCell colSpan={5}>Loading…</TableCell></TableRow>}
            {!loading && rows.length === 0 && <TableRow><TableCell colSpan={5}>No users found.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </TableContainer>

      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ color: 'black' }}>{editing ? 'Edit User' : 'Add User'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <Box sx={fieldBox}>
              <TextField label="Full name" value={fullName} onChange={e => setFullName(e.target.value)} fullWidth InputLabelProps={{style:{color:'black'}}} inputProps={{style:{color:'black'}}}/>
            </Box>
            <Box sx={fieldBox}>
              <TextField label="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} fullWidth disabled={!!editing} InputLabelProps={{style:{color:'black'}}} inputProps={{style:{color:'black'}}}/>
            </Box>
            <Box sx={fieldBox}>
              <FormControl fullWidth>
                <InputLabel sx={{ color: 'black' }}>Role</InputLabel>
                <Select value={role} label="Role" onChange={e => setRole(e.target.value as any)} sx={{ color: 'black' }}>
                  <MenuItem value="admin" sx={{ color: 'black' }}>admin</MenuItem>
                  <MenuItem value="subadmin" sx={{ color: 'black' }}>subadmin</MenuItem>
                </Select>
              </FormControl>
            </Box>
            <Box sx={fieldBox}>
              <FormControl fullWidth>
                <InputLabel sx={{ color: 'black' }}>States</InputLabel>
                <Select
                  multiple
                  value={states}
                  onChange={(e) => setStates(e.target.value as string[])}
                  input={<OutlinedInput label="States" sx={{ color: 'black' }} />}
                  renderValue={(selected) => (selected as string[]).join(', ')}
                  sx={{ color: 'black' }}
                >
                  {STATES.map(s => (
                    <MenuItem key={s.code} value={s.code} sx={{ color: 'black' }}>
                      {s.code} — {s.name}
                      
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Box>
            <Box sx={fieldBox}>
              <TextField label="Phone" value={phone} onChange={e => setPhone(e.target.value)} fullWidth InputLabelProps={{style:{color:'black'}}} inputProps={{style:{color:'black'}}}/>
            </Box>
            <Box sx={fieldBox}>
              <TextField label="User ID" value={userId} onChange={e => setUserId(e.target.value)} fullWidth helperText="Unique handle (letters, numbers, dashes). Auto-filled if left blank." InputLabelProps={{style:{color:'black'}}} inputProps={{style:{color:'black'}}} FormHelperTextProps={{style:{color:'black'}}}/>
            </Box>
            {!editing ? (
              <Box sx={fieldBox}>
                <TextField label="Password (required)" type="password" required value={password} onChange={e => setPassword(e.target.value)} fullWidth />
              </Box>
            ) : (
              <Box sx={fieldBox}>
                <TextField label="Reset password (optional)" type="password" value={password} onChange={e => setPassword(e.target.value)} fullWidth />
              </Box>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={onSave} disabled={!editing && !password.trim()}>
            Save
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
}
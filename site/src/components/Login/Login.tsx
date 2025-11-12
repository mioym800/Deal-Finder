import * as React from 'react';
import {
  Avatar, Button, CssBaseline, TextField, FormControlLabel,
  Checkbox, Link, Grid, Box, Typography, Container, Paper
} from '@mui/material';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { fetchLogin } from '../../helpers';
import { useNavigate } from 'react-router-dom';

const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: '#111827' },  // near-black
    secondary: { main: '#6366F1' }, // indigo
    background: { default: '#F3F4F6', paper: '#FFFFFF' },
  },
  typography: {
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial',
    h4: { fontWeight: 800, letterSpacing: 0.2 },
    button: { textTransform: 'none', fontWeight: 700 }
  },
  shape: { borderRadius: 14 },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: {
          border: '1px solid #E5E7EB',
          boxShadow: '0 10px 30px rgba(0,0,0,0.08)',
        }
      }
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          backgroundColor: '#fff'
        }
      }
    }
  }
});

export default function Login({ verify }: { verify?: (user: any) => void }): JSX.Element {
  const navigate = useNavigate();
  const [email, setEmail] = React.useState<string>('');
  const [password, setPassword] = React.useState<string>('');
  const [submitting, setSubmitting] = React.useState<boolean>(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetchLogin(email, password);
      if (res && res.success && res.token) {
        localStorage.setItem('authToken', res.token);
        localStorage.setItem('token', res.token);
        setSubmitting(false);

        if (typeof verify === 'function') {
          verify(res.user || null);
        }

        const isAdmin = !!(res?.user?.isAdmin || res?.user?.role === 'admin');
        navigate(isAdmin ? '/' : '/deals', { replace: true });
      } else {
        setError(res?.error || 'Login failed. Please try again.');
        setSubmitting(false);
      }
    } catch (e: any) {
      setError(e?.message || 'Login failed. Please try again.');
      setSubmitting(false);
    }
  };

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box
        sx={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          // Soft gradient background
          background: 'radial-gradient(1200px 600px at 20% -10%, #E0E7FF 0%, transparent 60%), radial-gradient(900px 500px at 100% 0%, #FDE68A 0%, transparent 55%), linear-gradient(180deg, #F9FAFB 0%, #F3F4F6 100%)',
          p: 2
        }}
      >
        <Container maxWidth="sm">
          <Paper
            elevation={0}
            sx={{
              p: { xs: 3, sm: 4, md: 5 },
              borderRadius: 4,
              backdropFilter: 'saturate(120%) blur(6px)',
            }}
          >
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mb: 2 }}>
              <Avatar sx={{ width: 64, height: 64, bgcolor: 'primary.main', mb: 2 }}>
                <LockOutlinedIcon fontSize="large" />
              </Avatar>
              <Typography variant="h4" sx={{ color: 'primary.main', textAlign: 'center' }}>
                MIOYM Deal Finder
              </Typography>
              <Typography sx={{ color: '#6B7280', mt: 1, textAlign: 'center' }}>
                Sign in to access your dashboard
              </Typography>
            </Box>

            <Box component="form" onSubmit={handleSubmit} noValidate>
              <TextField
                margin="normal"
                required
                fullWidth
                id="email"
                label="Email address or User ID"
                name="email"
                autoComplete="email"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                variant="outlined"
                sx={{ mt: 2 }}
                InputLabelProps={{}}
                InputProps={{}}
              />
              <TextField
                margin="normal"
                required
                fullWidth
                name="password"
                label="Password"
                type="password"
                id="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                variant="outlined"
                sx={{ mt: 1 }}
                InputLabelProps={{}}
                InputProps={{}}
              />
              <FormControlLabel
                sx={{ mt: 1 }}
                control={<Checkbox value="remember" color="primary" />}
                label={<Typography sx={{ color: '#374151' }}>Remember me</Typography>}
              />

              <Button
                type="submit"
                fullWidth
                variant="contained"
                sx={{
                  mt: 3,
                  mb: 1,
                  py: 1.6,
                  fontSize: 16,
                  borderRadius: 2.5,
                }}
                disabled={submitting}
              >
                {submitting ? 'Signing in…' : 'Sign In'}
              </Button>

              {error && (
                <Typography color="error" sx={{ mt: 1.5, textAlign: 'center' }}>
                  {error}
                </Typography>
              )}

              <Grid container sx={{ mt: 2 }}>
                <Grid item xs>
                  <Link href="#" variant="body2" sx={{ color: 'secondary.main' }}>
                    Forgot password?
                  </Link>
                </Grid>
              </Grid>
            </Box>
          </Paper>
        </Container>
      </Box>
    </ThemeProvider>
  );
}
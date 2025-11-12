import React, { useEffect, useState } from 'react';
import { Box, Button, Container, TextField, Typography, Alert, Stack } from '@mui/material';
import { getOtpState, submitOtpCode, cancelOtpRequest } from '../helpers';

interface OtpInfo {
  id: string;
  service: string;
  timeoutMs?: number;
  requestedAt?: number; // epoch ms when OTP was requested
  // any other backend-provided fields are allowed
  [key: string]: any;
}

export default function PrivyOtp(): JSX.Element {
  const [otpInfo, setOtpInfo] = useState<OtpInfo | null>(null);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Helper to compute remaining seconds from backend-provided timestamps
   const computeRemaining = (info: OtpInfo | null) => {
       if (!info) return null;
       const now = Date.now();
       let startMs = now;
       if (typeof info.requestedAt === 'number') {
         startMs = info.requestedAt;
       } else if (typeof info.requestedAt === 'string') {
         const d = Date.parse(info.requestedAt);
         if (!Number.isNaN(d)) startMs = d;
       }
       const ttl = typeof info.timeoutMs === 'number' ? info.timeoutMs : 0;
       const msLeft = Math.max(0, startMs + ttl - now);
       return Math.ceil(msLeft / 1000);
     };

  // Poll backend every 2s for current OTP state
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const data = await getOtpState();
        if (!active) return;
        const info = data?.otp || null;
        setOtpInfo(info);
        setRemaining(computeRemaining(info));
      } catch {
        // ignore poll errors
      }
    };
    const pollId = setInterval(poll, 2000);
    // initial poll immediately
    poll();
    return () => {
      active = false;
      clearInterval(pollId);
    };
  }, []);

  // Local countdown that recomputes from latest otpInfo (avoids stale closure)
  useEffect(() => {
    // update immediately when otpInfo changes
    const initial = computeRemaining(otpInfo);
    setRemaining(initial);

    if (!otpInfo) return;

    let active = true;
    const tickId = setInterval(async () => {
      if (!active) return;
      const r = computeRemaining(otpInfo);
      setRemaining(r);
      if (r === 0) {
        // Auto-clear banner when expired; tell backend to cancel
        try { await cancelOtpRequest(); } catch {}
        setOtpInfo(null);
        setCode('');
        setErr('OTP expired. Please trigger login again and enter the new code.');
      }
    }, 1000);

    return () => {
      active = false;
      clearInterval(tickId);
    };
  }, [otpInfo]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    setMsg(null); 
    setErr(null);
    try {
      // Always pull the latest OTP record to avoid stale ids
      const latest = await getOtpState().catch(() => null);
      const latestOtp = latest?.otp || null;

      const id = latestOtp?.id || otpInfo?.id;
      const service = latestOtp?.service || otpInfo?.service || 'privy';
      const trimmed = code.trim();

      if (!id) {
        setErr('No active OTP request found. Please re-initiate login.');
        setIsSubmitting(false);
        return;
      }
      if (!trimmed) {
        setErr('Please enter the code you received.');
        setIsSubmitting(false);
        return;
      }

      const resp = await submitOtpCode({ id, service, code: trimmed });
      if (resp?.ok) {
        setMsg('OTP submitted. The scraper will resume.');
        setCode('');
        // Quick refresh to clear the banner if the worker consumed it
        setTimeout(async () => {
          try {
            const s = await getOtpState();
            setOtpInfo(s?.otp || null);
            setRemaining(computeRemaining(s?.otp || null));
          } catch {}
        }, 1200);
      } else {
        setErr(resp?.error || 'Failed to submit OTP');
      }
    } catch (e: any) {
      setErr(e?.message || 'Unexpected error while submitting OTP');
    } finally {
      setIsSubmitting(false);
    }
  };

  const onCancel = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setMsg(null); 
    setErr(null);
    try {
      const resp = await cancelOtpRequest();
      if (resp?.ok) {
        setMsg('OTP request canceled.');
        setOtpInfo(null);
        setCode('');
      } else {
        setErr(resp?.error || 'Failed to cancel');
      }
    } catch (e: any) {
      setErr(e?.message || 'Unexpected error while canceling');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Container maxWidth="sm" sx={{ mt: 6, backgroundColor: 'white', color: 'black', p: 3, borderRadius: 2 }}>
      <Stack spacing={2}>
        <Typography variant="h5" fontWeight="bold" sx={{ color: 'black' }}>Privy OTP</Typography>

        {!otpInfo && (
          <Alert severity="info" sx={{ color: 'black', backgroundColor: '#e3f2fd', borderColor: '#90caf9' }}>
            No OTP is currently requested. When the worker hits a login challenge,
            it will appear here automatically.
          </Alert>
        )}

        {otpInfo && (
          <Alert severity="warning" sx={{ color: 'black', backgroundColor: '#fff3e0', borderColor: '#ffb74d' }}>
            <strong>OTP required</strong> for <code>{otpInfo.service}</code><br />
            Request ID: <code>{otpInfo.id}</code>{' '}
            {typeof remaining === 'number' ? (
              <>— expires in ~{remaining}s</>
            ) : otpInfo.timeoutMs ? (
              <>— expires in ~{Math.round((otpInfo.timeoutMs || 0) / 1000)}s</>
            ) : null}
          </Alert>
        )}

        <Box component="form" onSubmit={onSubmit}>
          <Stack direction="row" spacing={2}>
            <TextField
              label="Enter OTP code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D+/g, '').slice(0, 6))}
              fullWidth
              inputProps={{ inputMode: 'numeric' }}
              autoFocus
              InputLabelProps={{ sx: { color: 'black', '&.Mui-focused': { color: 'black' } } }}
              sx={{
                '& .MuiOutlinedInput-input': { color: 'black' },
                '& .MuiOutlinedInput-root': {
                  '& fieldset': { borderColor: '#000' },
                  '&:hover fieldset': { borderColor: '#333' },
                  '&.Mui-focused fieldset': { borderColor: '#0e6959', borderWidth: 2 },
                  backgroundColor: 'white',
                },
                // fix Chrome/Safari autofill (yellow bg and white text)
                '& input:-webkit-autofill': {
                  WebkitBoxShadow: '0 0 0 30px white inset',
                  WebkitTextFillColor: 'black',
                  caretColor: 'black',
                },
              }}
            />
            <Button
              variant="contained"
              type="submit"
              disabled={isSubmitting || !code.trim() || !otpInfo || remaining === 0}
              sx={{ backgroundColor: '#0e6959', color: 'white', '&:hover': { backgroundColor: '#095244' } }}
            >
              Submit
            </Button>
            <Button
              variant="outlined"
              onClick={onCancel}
              disabled={isSubmitting || !otpInfo || remaining === 0}
              sx={{ color: 'black', borderColor: 'black', '&:hover': { borderColor: '#555', color: '#555' } }}
            >
              Cancel
            </Button>
          </Stack>
          <Typography variant="caption" sx={{ display: 'block', mt: 0.5, color: 'black' }}>
            Tip: paste the full code you received (numbers only).
          </Typography>
        </Box>

        {msg && <Alert severity="success" sx={{ color: 'black', backgroundColor: '#d0f0c0', borderColor: '#a2d39c' }}>{msg}</Alert>}
        {err && <Alert severity="error" sx={{ color: 'black', backgroundColor: '#f8d7da', borderColor: '#f5c6cb' }}>{err}</Alert>}
      </Stack>
    </Container>
  );
}
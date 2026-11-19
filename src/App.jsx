import React, { useState, useEffect, useRef } from 'react';
import {
  Camera,
  RefreshCw,
  Play,
  Square,
  Copy,
  Lock,
  LogOut,
  Plus,
  X,
  Eye,
  EyeOff,
  Radio
} from 'lucide-react';

const REGIONS = [
  { value: 'de', label: 'Europe (DE)' },
  { value: 'us', label: 'United States (US)' },
  { value: 'cn', label: 'China (CN)' },
  { value: 'sg', label: 'Singapore (SG)' },
  { value: 'ru', label: 'Russia (RU)' },
  { value: 'i2', label: 'India (IN)' },
  { value: 'br', label: 'Brazil (via US)' },
  { value: 'ca', label: 'Canada (via US)' },
  { value: 'gb', label: 'UK (via DE)' },
];

const REGION_MAP = { br: 'us', ca: 'us', gb: 'de' };

export default function App() {
  const [streams, setStreams] = useState({});
  const [nightlightInfo, setNightlightInfo] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [devices, setDevices] = useState([]);
  const [selectedAccount, setSelectedAccount] = useState('');
  const [selectedRegion, setSelectedRegion] = useState('de');

  const [loadingDevices, setLoadingDevices] = useState(false);
  const [busyStream, setBusyStream] = useState(null);
  const [transcodeH264, setTranscodeH264] = useState(true);
  const [previewStream, setPreviewStream] = useState(null);
  const [playerReady, setPlayerReady] = useState(false);
  const playerRef = useRef(null);

  const [toast, setToast] = useState(null);
  const [showLoginModal, setShowLoginModal] = useState(false);

  // Admin auth
  const [authToken, setAuthToken] = useState(localStorage.getItem('micamera_admin_token') || '');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(true);

  // Xiaomi login flow
  const [loginStep, setLoginStep] = useState('credentials');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [captchaImg, setCaptchaImg] = useState('');
  const [captchaCode, setCaptchaCode] = useState('');
  const [verifyLabel, setVerifyLabel] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [submittingLogin, setSubmittingLogin] = useState(false);

  const notify = (msg, type = 'ok') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const authHeaders = (extra = {}) => {
    const h = { ...extra };
    if (authToken && authToken !== 'no_auth_configured') {
      h.Authorization = `Bearer ${authToken}`;
    }
    return h;
  };

  const copyText = (text, label) => {
    navigator.clipboard?.writeText(text);
    notify(`Copied ${label}`);
  };

  const fetchAll = async () => {
    try {
      const [sRes, nlRes] = await Promise.all([
        fetch('/api/streams', { headers: authHeaders() }),
        fetch('/api/nightlight', { headers: authHeaders() }),
      ]);
      if (sRes.ok) setStreams((await sRes.json()) || {});
      if (nlRes.ok) setNightlightInfo(await nlRes.json());
    } catch {
      // ignore transient poll error
    }
  };

  const fetchAccounts = async () => {
    try {
      const res = await fetch('/api/xiaomi', { headers: authHeaders() });
      if (res.ok) {
        const data = (await res.json()) || [];
        setAccounts(data);
        if (data.length > 0 && !selectedAccount) setSelectedAccount(data[0]);
      }
    } catch {
      // ignore
    }
  };

  const loadDevices = async (acc = selectedAccount, reg = selectedRegion) => {
    if (!acc) return;
    setLoadingDevices(true);
    try {
      const params = new URLSearchParams({ id: acc, region: REGION_MAP[reg] || reg });
      const res = await fetch(`/api/xiaomi?${params}`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        const mapped = (data?.sources || []).map((dev) => {
          const m = dev.url?.match(/[?&]did=([^&]+)/);
          return { ...dev, id: m ? m[1] : dev.name };
        });
        setDevices(mapped);
      } else {
        setDevices([]);
        notify(`Failed to load cameras: ${await res.text()}`, 'error');
      }
    } catch {
      notify('Network error loading cameras', 'error');
    } finally {
      setLoadingDevices(false);
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/auth/status');
        const data = await res.json();
        setAuthRequired(data.authRequired);
        if (!data.authRequired) {
          setIsAuthenticated(true);
        } else if (authToken) {
          const chk = await fetch('/api/auth/check', { headers: { Authorization: `Bearer ${authToken}` } });
          if (chk.ok) setIsAuthenticated(true);
          else {
            localStorage.removeItem('micamera_admin_token');
            setAuthToken('');
          }
        }
      } finally {
        setAuthLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    fetchAll();
    fetchAccounts();
    const t = setInterval(fetchAll, 4000);
    return () => clearInterval(t);
  }, [isAuthenticated]);

  useEffect(() => {
    if (isAuthenticated && selectedAccount) {
      loadDevices(selectedAccount, selectedRegion);
    }
  }, [isAuthenticated, selectedAccount, selectedRegion]);

  // Load go2rtc video-stream custom element only when preview is opened
  useEffect(() => {
    if (!isAuthenticated || !previewStream || playerReady) return;
    const script = document.createElement('script');
    script.src = '/video-stream.js';
    script.type = 'module';
    script.onload = () => {
      customElements.whenDefined('video-stream').then(() => setPlayerReady(true));
    };
    document.body.appendChild(script);
  }, [isAuthenticated, previewStream, playerReady]);

  useEffect(() => {
    if (!playerReady || !previewStream || !playerRef.current) return;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const tokenQ = authRequired && authToken ? `&token=${encodeURIComponent(authToken)}` : '';
    playerRef.current.src = `${proto}//${window.location.host}/api/ws?src=${encodeURIComponent(previewStream)}${tokenQ}`;
  }, [playerReady, previewStream, authRequired, authToken]);

  const handleAdminLogin = async (e) => {
    e.preventDefault();
    setAuthError('');
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: adminPassword }),
    });
    const data = await res.json();
    if (res.ok && data.success) {
      localStorage.setItem('micamera_admin_token', data.token);
      setAuthToken(data.token);
      setIsAuthenticated(true);
      setAdminPassword('');
    } else {
      setAuthError(data.error || 'Incorrect password');
    }
  };

  const resetLogin = () => {
    setLoginStep('credentials');
    setUsername('');
    setPassword('');
    setCaptchaCode('');
    setCaptchaImg('');
    setVerifyCode('');
    setVerifyLabel('');
  };

  const submitXiaomiStep = async (paramsObj) => {
    setSubmittingLogin(true);
    try {
      const body = new URLSearchParams(paramsObj);
      const res = await fetch('/api/xiaomi', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
        body: body.toString(),
      });
      if (res.status === 401) {
        const data = await res.json();
        if (data.captcha) {
          setCaptchaImg(data.captcha);
          setCaptchaCode('');
          setLoginStep('captcha');
        } else if (data.verify_email || data.verify_phone) {
          setVerifyLabel(data.verify_email || data.verify_phone);
          setLoginStep('verify');
        } else {
          setVerifyCode('');
          notify('Invalid code. Try again.', 'error');
        }
      } else if (res.ok) {
        notify('Xiaomi account connected');
        await fetchAccounts();
        setShowLoginModal(false);
        resetLogin();
      } else {
        notify(`Login failed: ${await res.text()}`, 'error');
      }
    } catch {
      notify('Network error during Xiaomi login', 'error');
    } finally {
      setSubmittingLogin(false);
    }
  };

  const handleXiaomiLogout = async (accountId) => {
    const res = await fetch('/api/xiaomi/logout', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ id: accountId }),
    });
    if (res.ok) {
      notify(`Disconnected ${accountId}`);
      setAccounts((prev) => {
        const next = prev.filter((a) => a !== accountId);
        setSelectedAccount(next[0] || '');
        if (next.length === 0) setDevices([]);
        return next;
      });
    }
  };

  const toSlug = (name) =>
    (name || 'camera')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'camera';

  const publishCamera = async (device, subtype = 'hd') => {
    const cleanName = toSlug(device.name);
    setBusyStream(cleanName);
    try {
      let streamUrl = device.url;
      if (device.url.includes('xiaomi://')) {
        const u = new URL(device.url);
        u.searchParams.set('subtype', subtype);
        streamUrl = u.toString().replace('xiaomi/', 'xiaomi://');
      }
      if (transcodeH264) {
        const rawName = `${cleanName}_raw`;
        const rawParams = new URLSearchParams({ name: rawName, src: streamUrl });
        const rawRes = await fetch(`/api/streams?${rawParams}`, {
          method: 'PUT',
          headers: authHeaders(),
        });
        if (!rawRes.ok) {
          notify(`Failed to publish raw stream: ${await rawRes.text()}`, 'error');
          return;
        }
        streamUrl = `ffmpeg:${rawName}#video=h264#audio=copy`;
      }
      const params = new URLSearchParams({ name: cleanName, src: streamUrl });
      const res = await fetch(`/api/streams?${params}`, {
        method: 'PUT',
        headers: authHeaders(),
      });
      if (res.ok) {
        notify(`Published "${cleanName}" (${subtype.toUpperCase()})`);
        await fetchAll();
      } else {
        notify(`Failed to publish: ${await res.text()}`, 'error');
      }
    } finally {
      setBusyStream(null);
    }
  };

  const unpublishStream = async (name) => {
    setBusyStream(name);
    try {
      const params = new URLSearchParams({ src: name });
      const res = await fetch(`/api/streams?${params}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      await fetch(`/api/streams?${new URLSearchParams({ src: `${name}_raw` })}`, {
        method: 'DELETE',
        headers: authHeaders(),
      }).catch(() => {});
      if (res.ok) {
        if (previewStream === name) setPreviewStream(null);
        notify(`Stopped "${name}"`);
        await fetchAll();
      }
    } finally {
      setBusyStream(null);
    }
  };

  const activeNameForDevice = (device) => {
    const slug = toSlug(device.name);
    return Object.keys(streams).find((key) => {
      if (key.endsWith('_raw')) return false;
      const info = streams[key];
      const src = typeof info === 'string' ? info : JSON.stringify(info || '');
      return src.includes(`did=${device.id}`) || key === slug || key === device.name;
    });
  };

  if (authLoading) {
    return <div className="page"><div className="empty">Loading…</div></div>;
  }

  if (authRequired && !isAuthenticated) {
    return (
      <div className="modal-backdrop">
        <form className="modal" onSubmit={handleAdminLogin}>
          <div className="brand">
            <div className="brand-icon"><Lock size={18} /></div>
            <div>
              <h1>Nightlight MiBridge</h1>
              <p>Enter admin password</p>
            </div>
          </div>
          <input
            type="password"
            className="input"
            placeholder="Admin password"
            value={adminPassword}
            onChange={(e) => setAdminPassword(e.target.value)}
            autoFocus
            required
          />
          {authError && <div className="muted" style={{ color: '#fda4af' }}>{authError}</div>}
          <button type="submit" className="btn btn-primary">Unlock</button>
        </form>
      </div>
    );
  }

  const publishedStreams = nightlightInfo?.streams || [];

  return (
    <div className="page">
      <header className="header">
        <div className="brand">
          <div className="brand-icon"><Radio size={18} /></div>
          <div>
            <h1>Nightlight MiBridge</h1>
            <p>Xiaomi Cloud → ONVIF &amp; RTSP bridge for Nightlight</p>
          </div>
        </div>

        <div className="actions">
          <span className={`pill ${publishedStreams.length ? 'pill-ok' : ''}`}>
            {publishedStreams.length} active · RTSP :{nightlightInfo?.rtspPort || 8555}
          </span>
          <button className="btn btn-primary" onClick={() => setShowLoginModal(true)}>
            <Plus size={15} /> Connect Xiaomi
          </button>
          {authRequired && (
            <button
              className="btn"
              onClick={() => {
                localStorage.removeItem('micamera_admin_token');
                setAuthToken('');
                setIsAuthenticated(false);
              }}
              title="Lock"
            >
              <LogOut size={15} />
            </button>
          )}
        </div>
      </header>

      <section className="card">
        <div className="card-header">
          <h2 className="card-title"><Camera size={16} /> Active Nightlight Bridges</h2>
          <span className="muted">
            In Nightlight → Cameras → Add camera, use <b>Find cameras on my network</b> or <b>Fetch from ONVIF</b>
          </span>
        </div>

        {publishedStreams.length === 0 ? (
          <div className="empty">
            No streams published yet. Publish a Xiaomi camera below to expose its ONVIF &amp; RTSP endpoints.
          </div>
        ) : (
          <div className="grid">
            {publishedStreams.map((s) => (
              <div className="stream-card" key={s.name}>
                <div className="stream-top">
                  <div>
                    <div className="stream-name">{s.name}</div>
                    <span className="pill pill-ok" style={{ display: 'inline-block', marginTop: 4 }}>ONVIF + RTSP</span>
                  </div>
                  <div className="actions">
                    <button
                      className="btn btn-sm"
                      onClick={() => setPreviewStream(previewStream === s.name ? null : s.name)}
                      title="Toggle preview"
                    >
                      {previewStream === s.name ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      disabled={busyStream === s.name}
                      onClick={() => unpublishStream(s.name)}
                      title="Stop bridge"
                    >
                      <Square size={13} />
                    </button>
                  </div>
                </div>

                <div className="kv">
                  <span className="kv-label">ONVIF</span>
                  <span className="kv-val">{window.location.hostname}:{s.onvifPort}</span>
                  <button
                    className="copy-btn"
                    onClick={() => copyText(String(s.onvifPort), 'ONVIF port')}
                    title="Copy ONVIF port"
                  >
                    <Copy size={13} />
                  </button>
                </div>

                <div className="kv">
                  <span className="kv-label">RTSP</span>
                  <span className="kv-val">{s.rtspUrl}</span>
                  <button
                    className="copy-btn"
                    onClick={() => copyText(s.rtspUrl, 'RTSP URL')}
                    title="Copy RTSP URL"
                  >
                    <Copy size={13} />
                  </button>
                </div>

                {previewStream === s.name && (
                  <div className="preview-box">
                    {playerReady ? (
                      <video-stream
                        key={s.name}
                        ref={playerRef}
                        style={{ width: '100%', display: 'block', aspectRatio: '16/9' }}
                      />
                    ) : (
                      <div className="empty" style={{ border: 'none' }}>Loading preview…</div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Xiaomi Cloud Cameras</h2>
          <div className="actions">
            <label className="pill" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={transcodeH264}
                onChange={(e) => setTranscodeH264(e.target.checked)}
              />
              H.264 transcode (for C400 / HEVC)
            </label>
            {accounts.length > 0 && (
              <>
                <select
                  className="select"
                  value={selectedAccount}
                  onChange={(e) => setSelectedAccount(e.target.value)}
                >
                  {accounts.map((acc) => (
                    <option key={acc} value={acc}>{acc}</option>
                  ))}
                </select>
                <select
                  className="select"
                  value={selectedRegion}
                  onChange={(e) => setSelectedRegion(e.target.value)}
                >
                  {REGIONS.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
                <button
                  className="btn"
                  disabled={loadingDevices}
                  onClick={() => loadDevices(selectedAccount, selectedRegion)}
                >
                  <RefreshCw size={14} className={loadingDevices ? 'spin' : ''} /> Refresh
                </button>
                <button
                  className="btn btn-danger"
                  onClick={() => handleXiaomiLogout(selectedAccount)}
                  title="Disconnect Xiaomi account"
                >
                  <LogOut size={14} />
                </button>
              </>
            )}
          </div>
        </div>

        {accounts.length === 0 ? (
          <div className="empty">
            No Xiaomi account connected. Click <b>Connect Xiaomi</b> above to discover your cameras.
          </div>
        ) : loadingDevices ? (
          <div className="empty">Discovering cameras…</div>
        ) : devices.length === 0 ? (
          <div className="empty">No cameras found in this region. Try switching the region dropdown.</div>
        ) : (
          <div className="grid">
            {devices.map((dev) => {
              const activeName = activeNameForDevice(dev);
              const cleanName = toSlug(dev.name);
              const isBusy = busyStream === cleanName || busyStream === activeName;
              return (
                <div className="stream-card" key={dev.id}>
                  <div className="stream-top">
                    <div>
                      <div className="stream-name">{dev.name}</div>
                      <div className="muted" style={{ fontFamily: 'monospace', marginTop: 2 }}>{dev.id}</div>
                    </div>
                    {activeName && <span className="pill pill-ok">Active</span>}
                  </div>
                  <div className="actions">
                    {activeName ? (
                      <button
                        className="btn btn-sm btn-danger"
                        disabled={isBusy}
                        onClick={() => unpublishStream(activeName)}
                      >
                        <Square size={13} /> Stop Bridge
                      </button>
                    ) : (
                      <>
                        <button
                          className="btn btn-sm btn-primary"
                          disabled={isBusy}
                          onClick={() => publishCamera(dev, 'hd')}
                        >
                          <Play size={13} /> Publish HD
                        </button>
                        <button
                          className="btn btn-sm"
                          disabled={isBusy}
                          onClick={() => publishCamera(dev, 'sd')}
                        >
                          Publish SD
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {showLoginModal && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="card-header">
              <h3 className="card-title">Connect Xiaomi Account</h3>
              <button className="copy-btn" onClick={() => { setShowLoginModal(false); resetLogin(); }}>
                <X size={16} />
              </button>
            </div>

            {loginStep === 'credentials' && (
              <form
                style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  submitXiaomiStep({ username, password });
                }}
              >
                <input
                  className="input"
                  placeholder="Xiaomi ID / Email / Phone"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                />
                <input
                  type="password"
                  className="input"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button className="btn btn-primary" disabled={submittingLogin} type="submit">
                  {submittingLogin ? 'Signing in…' : 'Sign in'}
                </button>
              </form>
            )}

            {loginStep === 'captcha' && (
              <form
                style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  submitXiaomiStep({ captcha: captchaCode });
                }}
              >
                {captchaImg && (
                  <img
                    src={captchaImg.startsWith('data:') ? captchaImg : `data:image/png;base64,${captchaImg}`}
                    alt="Captcha"
                    style={{ borderRadius: 8, background: '#fff', maxWidth: '100%' }}
                  />
                )}
                <input
                  className="input"
                  placeholder="Enter captcha"
                  value={captchaCode}
                  onChange={(e) => setCaptchaCode(e.target.value)}
                  autoFocus
                  required
                />
                <button className="btn btn-primary" disabled={submittingLogin} type="submit">
                  {submittingLogin ? 'Verifying…' : 'Verify Captcha'}
                </button>
              </form>
            )}

            {loginStep === 'verify' && (
              <form
                style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  submitXiaomiStep({ verify: verifyCode });
                }}
              >
                <div className="muted">Enter 2FA code sent to: <b>{verifyLabel}</b></div>
                <input
                  className="input"
                  placeholder="6-digit code"
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value)}
                  autoFocus
                  required
                />
                <button className="btn btn-primary" disabled={submittingLogin} type="submit">
                  {submittingLogin ? 'Verifying…' : 'Verify Code'}
                </button>
              </form>
            )}
          </div>
        </div>
      )}

      {toast && (
        <div className={`toast ${toast.type === 'error' ? 'toast-error' : ''}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

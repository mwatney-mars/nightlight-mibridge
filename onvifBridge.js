import http from 'http';
import dgram from 'dgram';
import crypto from 'crypto';
import os from 'os';

const DEFAULT_GO2RTC_URL = 'http://127.0.0.1:1984';
const DEFAULT_RTSP_PORT = Number(process.env.RTSP_PORT) || 8554;
const DEFAULT_ONVIF_BASE_PORT = Number(process.env.ONVIF_BASE_PORT) || 8901;
const ONVIF_ENABLED = process.env.ONVIF_ENABLED !== 'false';
const WS_DISCOVERY_ENABLED = process.env.ONVIF_DISCOVERY !== 'false';

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getLocalLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function parseHostHeader(hostHeader, fallbackPort) {
  const raw = (hostHeader || '').trim();
  if (!raw) return { host: getLocalLanIp(), port: fallbackPort };
  // Handle IPv6 [::1]:8901 or IPv4 192.168.1.10:8901
  if (raw.startsWith('[')) {
    const idx = raw.indexOf(']');
    const host = idx !== -1 ? raw.slice(0, idx + 1) : raw;
    const portPart = idx !== -1 && raw[idx + 1] === ':' ? raw.slice(idx + 2) : '';
    return { host, port: Number(portPart) || fallbackPort };
  }
  const colonIdx = raw.lastIndexOf(':');
  if (colonIdx !== -1) {
    return {
      host: raw.slice(0, colonIdx),
      port: Number(raw.slice(colonIdx + 1)) || fallbackPort,
    };
  }
  return { host: raw, port: fallbackPort };
}

function soapEnvelope(bodyXml) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
  xmlns:tds="http://www.onvif.org/ver10/device/wsdl"
  xmlns:trt="http://www.onvif.org/ver10/media/wsdl"
  xmlns:tt="http://www.onvif.org/ver10/schema"
  xmlns:ter="http://www.onvif.org/ver10/error">
  <s:Body>${bodyXml}</s:Body>
</s:Envelope>`;
}

function soapFault(subcode, reason) {
  return soapEnvelope(`
    <s:Fault>
      <s:Code>
        <s:Value>s:Sender</s:Value>
        <s:Subcode><s:Value>${escapeXml(subcode)}</s:Value></s:Subcode>
      </s:Code>
      <s:Reason><s:Text xml:lang="en">${escapeXml(reason)}</s:Text></s:Reason>
    </s:Fault>`);
}

function detectAction(soapBody) {
  // Match the first element inside <*:Body> or known ONVIF operation names
  const bodyMatch = /<(?:\w+:)?Body[^>]*>\s*<(?:\w+:)?([A-Za-z0-9_]+)/i.exec(soapBody);
  if (bodyMatch) return bodyMatch[1];
  return '';
}

function buildOnvifXmlResponse({ action, streamName, host, port, rtspPort }) {
  const baseUrl = `http://${host}:${port}`;
  const safeName = escapeXml(streamName);

  switch (action) {
    case 'GetSystemDateAndTime': {
      const now = new Date();
      return {
        status: 200,
        xml: soapEnvelope(`
          <tds:GetSystemDateAndTimeResponse>
            <tds:SystemDateAndTime>
              <tt:DateTimeType>NTP</tt:DateTimeType>
              <tt:DaylightSavings>false</tt:DaylightSavings>
              <tt:TimeZone><tt:TZ>UTC0</tt:TZ></tt:TimeZone>
              <tt:UTCDateTime>
                <tt:Time>
                  <tt:Hour>${now.getUTCHours()}</tt:Hour>
                  <tt:Minute>${now.getUTCMinutes()}</tt:Minute>
                  <tt:Second>${now.getUTCSeconds()}</tt:Second>
                </tt:Time>
                <tt:Date>
                  <tt:Year>${now.getUTCFullYear()}</tt:Year>
                  <tt:Month>${now.getUTCMonth() + 1}</tt:Month>
                  <tt:Day>${now.getUTCDate()}</tt:Day>
                </tt:Date>
              </tt:UTCDateTime>
            </tds:SystemDateAndTime>
          </tds:GetSystemDateAndTimeResponse>`),
      };
    }

    case 'GetCapabilities':
      return {
        status: 200,
        xml: soapEnvelope(`
          <tds:GetCapabilitiesResponse>
            <tds:Capabilities>
              <tt:Device>
                <tt:XAddr>${escapeXml(baseUrl)}/onvif/device_service</tt:XAddr>
              </tt:Device>
              <tt:Media>
                <tt:XAddr>${escapeXml(baseUrl)}/onvif/media_service</tt:XAddr>
                <tt:StreamingCapabilities>
                  <tt:RTPMulticast>false</tt:RTPMulticast>
                  <tt:RTP_TCP>true</tt:RTP_TCP>
                  <tt:RTP_RTSP_TCP>true</tt:RTP_RTSP_TCP>
                </tt:StreamingCapabilities>
              </tt:Media>
            </tds:Capabilities>
          </tds:GetCapabilitiesResponse>`),
      };

    case 'GetServices':
      return {
        status: 200,
        xml: soapEnvelope(`
          <tds:GetServicesResponse>
            <tds:Service>
              <tds:Namespace>http://www.onvif.org/ver10/device/wsdl</tds:Namespace>
              <tds:XAddr>${escapeXml(baseUrl)}/onvif/device_service</tds:XAddr>
              <tds:Version><tt:Major>2</tt:Major><tt:Minor>0</tt:Minor></tds:Version>
            </tds:Service>
            <tds:Service>
              <tds:Namespace>http://www.onvif.org/ver10/media/wsdl</tds:Namespace>
              <tds:XAddr>${escapeXml(baseUrl)}/onvif/media_service</tds:XAddr>
              <tds:Version><tt:Major>2</tt:Major><tt:Minor>0</tt:Minor></tds:Version>
            </tds:Service>
          </tds:GetServicesResponse>`),
      };

    case 'GetDeviceInformation':
      return {
        status: 200,
        xml: soapEnvelope(`
          <tds:GetDeviceInformationResponse>
            <tds:Manufacturer>Xiaomi (MiCameraPro)</tds:Manufacturer>
            <tds:Model>${safeName}</tds:Model>
            <tds:FirmwareVersion>1.0.0</tds:FirmwareVersion>
            <tds:SerialNumber>${safeName}</tds:SerialNumber>
            <tds:HardwareId>micamerapro-go2rtc</tds:HardwareId>
          </tds:GetDeviceInformationResponse>`),
      };

    case 'GetProfiles':
      return {
        status: 200,
        xml: soapEnvelope(`
          <trt:GetProfilesResponse>
            <trt:Profiles token="profile_main" fixed="true">
              <tt:Name>MainStream</tt:Name>
              <tt:VideoSourceConfiguration token="vsc_1">
                <tt:Name>VideoSource</tt:Name>
                <tt:UseCount>1</tt:UseCount>
                <tt:SourceToken>vs_1</tt:SourceToken>
                <tt:Bounds x="0" y="0" width="1920" height="1080"/>
              </tt:VideoSourceConfiguration>
              <tt:VideoEncoderConfiguration token="vec_1">
                <tt:Name>H264</tt:Name>
                <tt:UseCount>1</tt:UseCount>
                <tt:Encoding>H264</tt:Encoding>
                <tt:Resolution>
                  <tt:Width>1920</tt:Width>
                  <tt:Height>1080</tt:Height>
                </tt:Resolution>
                <tt:Quality>5</tt:Quality>
              </tt:VideoEncoderConfiguration>
            </trt:Profiles>
          </trt:GetProfilesResponse>`),
      };

    case 'GetStreamUri': {
      const rtspUri = `rtsp://${host}:${rtspPort}/${encodeURIComponent(streamName)}`;
      return {
        status: 200,
        xml: soapEnvelope(`
          <trt:GetStreamUriResponse>
            <trt:MediaUri>
              <tt:Uri>${escapeXml(rtspUri)}</tt:Uri>
              <tt:InvalidAfterConnect>false</tt:InvalidAfterConnect>
              <tt:InvalidAfterReboot>false</tt:InvalidAfterReboot>
              <tt:Timeout>PT60S</tt:Timeout>
            </trt:MediaUri>
          </trt:GetStreamUriResponse>`),
      };
    }

    case 'GetAudioOutputConfigurations':
      return {
        status: 500,
        xml: soapFault('ter:ActionNotSupported', 'AudioOutputNotSupported'),
      };

    case 'GetEventProperties':
    case 'CreatePullPointSubscription':
      return {
        status: 500,
        xml: soapFault('ter:ActionNotSupported', 'Events not supported'),
      };

    default:
      return {
        status: 500,
        xml: soapFault('ter:ActionNotSupported', `Unsupported ONVIF action: ${action}`),
      };
  }
}

export function createOnvifBridge({
  go2rtcUrl = DEFAULT_GO2RTC_URL,
  rtspPort = DEFAULT_RTSP_PORT,
  onvifBasePort = DEFAULT_ONVIF_BASE_PORT,
  enabled = ONVIF_ENABLED,
  discoveryEnabled = WS_DISCOVERY_ENABLED,
} = {}) {
  // Map<streamName, { port, server }>
  const streamServers = new Map();
  let nextPort = onvifBasePort;
  let pollTimer = null;
  let discoverySocket = null;
  let syncing = false;

  const getPortForStream = (name) => {
    const existing = streamServers.get(name);
    if (existing) return existing.port;
    const usedPorts = new Set([...streamServers.values()].map((v) => v.port));
    let candidate = onvifBasePort;
    while (usedPorts.has(candidate)) candidate++;
    return candidate;
  };

  const startStreamServer = (streamName) => {
    if (!enabled || streamServers.has(streamName)) return;
    const port = getPortForStream(streamName);

    const server = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method Not Allowed');
        return;
      }

      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 256 * 1024) req.destroy();
      });
      req.on('end', () => {
        const action = detectAction(body);
        const { host } = parseHostHeader(req.headers.host, port);
        const { status, xml } = buildOnvifXmlResponse({
          action,
          streamName,
          host,
          port,
          rtspPort,
        });
        res.writeHead(status, {
          'Content-Type': 'application/soap+xml; charset=utf-8',
        });
        res.end(xml);
      });
    });

    server.on('error', (err) => {
      console.warn(`[ONVIF] Server error for "${streamName}" on port ${port}:`, err.message);
    });

    server.listen(port, '0.0.0.0', () => {
      console.log(`[ONVIF] Stream "${streamName}" exposed at http://0.0.0.0:${port}/onvif/device_service -> rtsp://<host>:${rtspPort}/${streamName}`);
    });

    streamServers.set(streamName, { port, server });
  };

  const stopStreamServer = (streamName) => {
    const entry = streamServers.get(streamName);
    if (!entry) return;
    entry.server.close();
    streamServers.delete(streamName);
    console.log(`[ONVIF] Stopped ONVIF server for removed stream "${streamName}"`);
  };

  const syncStreams = async () => {
    if (syncing) return;
    syncing = true;
    try {
      const res = await fetch(`${go2rtcUrl}/api/streams`);
      if (!res.ok) return;
      const data = await res.json();
      const activeNames = new Set(
        Object.keys(data || {}).filter((name) => !name.endsWith('_raw'))
      );

      for (const name of activeNames) {
        if (!streamServers.has(name)) {
          startStreamServer(name);
        }
      }
      for (const name of [...streamServers.keys()]) {
        if (!activeNames.has(name)) {
          stopStreamServer(name);
        }
      }
    } catch {
      // go2rtc may still be booting
    } finally {
      syncing = false;
    }
  };

  const startWsDiscovery = () => {
    if (!enabled || !discoveryEnabled) return;
    try {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('error', (err) => {
        console.warn('[ONVIF] WS-Discovery socket warning (non-fatal):', err.message);
        try { sock.close(); } catch {}
        discoverySocket = null;
      });
      sock.on('message', (msg, rinfo) => {
        const text = msg.toString('utf8');
        if (!text.includes('Probe') || (!text.includes('NetworkVideoTransmitter') && !text.includes('Device'))) {
          return;
        }
        const msgIdMatch = /<(?:\w+:)?MessageID[^>]*>([^<]+)</i.exec(text);
        const relatesTo = msgIdMatch ? msgIdMatch[1].trim() : `urn:uuid:${crypto.randomUUID()}`;
        const lanIp = getLocalLanIp();

        for (const [streamName, { port }] of streamServers.entries()) {
          const uuid = crypto.createHash('md5').update(`micamerapro:${streamName}`).digest('hex');
          const formattedUuid = `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20, 32)}`;
          const probeMatch = `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
  xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing"
  xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
  xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <s:Header>
    <a:MessageID>urn:uuid:${crypto.randomUUID()}</a:MessageID>
    <a:RelatesTo>${escapeXml(relatesTo)}</a:RelatesTo>
    <a:To>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:To>
    <a:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/ProbeMatches</a:Action>
  </s:Header>
  <s:Body>
    <d:ProbeMatches>
      <d:ProbeMatch>
        <a:EndpointReference>
          <a:Address>urn:uuid:${formattedUuid}</a:Address>
        </a:EndpointReference>
        <d:Types>dn:NetworkVideoTransmitter</d:Types>
        <d:Scopes>onvif://www.onvif.org/type/video_encoder onvif://www.onvif.org/name/${escapeXml(encodeURIComponent(streamName))} onvif://www.onvif.org/hardware/MiCameraPro</d:Scopes>
        <d:XAddrs>http://${lanIp}:${port}/onvif/device_service</d:XAddrs>
        <d:MetadataVersion>1</d:MetadataVersion>
      </d:ProbeMatch>
    </d:ProbeMatches>
  </s:Body>
</s:Envelope>`;
          const buf = Buffer.from(probeMatch, 'utf8');
          sock.send(buf, 0, buf.length, rinfo.port, rinfo.address, () => {});
        }
      });
      sock.bind(3702, '0.0.0.0', () => {
        try {
          sock.addMembership('239.255.255.250');
          console.log('[ONVIF] WS-Discovery responder listening on UDP 239.255.255.250:3702');
        } catch (err) {
          console.warn('[ONVIF] Could not join WS-Discovery multicast group:', err.message);
        }
      });
      discoverySocket = sock;
    } catch (err) {
      console.warn('[ONVIF] WS-Discovery init failed (non-fatal):', err.message);
    }
  };

  const start = () => {
    if (!enabled) {
      console.log('[ONVIF] Bridge disabled via ONVIF_ENABLED=false');
      return;
    }
    syncStreams();
    pollTimer = setInterval(syncStreams, 5000);
    startWsDiscovery();
  };

  const stop = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (discoverySocket) {
      try { discoverySocket.close(); } catch {}
      discoverySocket = null;
    }
    for (const name of [...streamServers.keys()]) {
      stopStreamServer(name);
    }
  };

  const getStatus = (requestHost) => {
    const { host } = parseHostHeader(requestHost, null);
    const streams = [...streamServers.entries()].map(([name, { port }]) => ({
      name,
      rtspUrl: `rtsp://${host}:${rtspPort}/${encodeURIComponent(name)}`,
      rtspPort,
      rtspPath: `/${encodeURIComponent(name)}`,
      onvifPort: port,
      onvifUrl: `http://${host}:${port}/onvif/device_service`,
    }));
    return {
      rtspPort,
      onvifEnabled: enabled,
      onvifBasePort,
      streams,
    };
  };

  return { start, stop, syncStreams, getStatus };
}

import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const stationSession = `0x${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;

const tracks = [
  { time: "NOW", title: "Open frequencies", meta: "Patio transmission / live experiment" },
  { time: "NEXT", title: "A signal looking for a listener", meta: "queued for the next window" },
  { time: "LATER", title: "Night bus through the mempool", meta: "coming soon" },
];

function App() {
  const [playing, setPlaying] = useState(false);
  const [mode, setMode] = useState<"tune" | "cast">("tune");
  const [castTitle, setCastTitle] = useState("");
  const [castReady, setCastReady] = useState(false);
  const [packets, setPackets] = useState(0);
  const [recentPackets, setRecentPackets] = useState<number[]>([]);
  const packetPreview = playing ? `0x504154494f${packets.toString(16).padStart(8, "0")}...` : "waiting for packet";
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setPackets((value) => { const next = value + 1; setRecentPackets((items) => [next, ...items].slice(0, 3)); return next; }), 900);
    return () => window.clearInterval(timer);
  }, [playing]);
  return <main className="shell">
    <nav><span className="brand"><i /> PATIO</span><span className="nav-note">PUBLIC FREQUENCY / 001 · HOODI TESTNET</span><span className="mode-switch"><button className={mode === "tune" ? "selected" : ""} onClick={() => setMode("tune")}>TUNE IN</button><button className={mode === "cast" ? "selected" : ""} onClick={() => setMode("cast")}>CAST</button></span><span className="clock">TOKYO 02:14</span></nav>
    <section className="hero"><div className="hero-copy"><p className="kicker">PAT.IO {mode === "cast" ? "CAST DECK" : "RADIO"} <span>● {mode === "cast" ? "PREP TEST" : "LIVE TEST"}</span></p><h1>{mode === "cast" ? <>Send a signal<br /><em>into the open.</em></> : <>Information wants<br /><em>to travel.</em></>}</h1><p className="intro">{mode === "cast" ? "Prepare a station for a future broadcast. The sender is offline while the first transport is being tested." : "A small station for audio carried across open networks. Tune in while the signal is still experimental."}</p></div><div className="station-art"><div className="rings" /><strong>104.2</strong><small>FM / PATIO</small></div></section>
    {mode === "cast" && <section className="cast-panel"><div><p className="overline">NEW TRANSMISSION</p><h2>{castReady ? "Broadcast staged" : "Give this signal a name"}</h2><p className="muted">{castReady ? "Ready for the future sender pipeline. Nothing has been broadcast." : "This first form only prepares local metadata for a later cast."}</p></div><div className="cast-controls"><input value={castTitle} onChange={(event) => { setCastTitle(event.target.value); setCastReady(false); }} placeholder="e.g. midnight transmission" /><label className="file-input">CHOOSE AUDIO<input type="file" accept="audio/*" /></label><button disabled={!castTitle.trim()} onClick={() => setCastReady(true)}>{castReady ? "READY" : "PREPARE CAST"}</button></div></section>}
    <section className="player"><div className="play-row"><button className="play" onClick={() => setPlaying(!playing)} aria-label={playing ? "Pause" : "Play"}>{playing ? "Ⅱ" : "▶"}</button><div><p className="overline">{playing ? "NOW PLAYING" : "READY TO TUNE IN"}</p><h2>{playing ? "Open frequencies" : "Patio Radio"}</h2><p className="muted">{playing ? "A test signal from the public mempool" : "The first broadcast is waiting"}</p></div><div className={`levels ${playing ? "active" : ""}`}><b /><b /><b /><b /><b /><b /><b /></div></div><div className="progress"><span /><span /><span /></div><div className="player-meta"><span>00:00</span><span>{playing ? "OPUS / WEBM · RECEIVING" : "OPUS / WEBM · NO STREAM CONNECTED"}</span><span>--:--</span></div></section>
    <section className="lower"><div className="schedule"><p className="overline">STATION LOG</p>{tracks.map((track) => <article key={track.time}><time>{track.time}</time><div><strong>{track.title}</strong><small>{track.meta}</small></div><span>↗</span></article>)}</div><aside><p className="overline">SIGNAL STATUS</p><div className="signal"><span /> <strong>{playing ? "RECEIVING" : "LISTENING"}</strong></div><p className="muted">{playing ? "A simulated listener is receiving packets from the station." : "The station is prepared to receive its first packet. This panel will show live network data when the transport is connected."}</p><div className="meter">{Array.from({ length: 10 }, (_, index) => <span className={playing && index < 4 + packets % 6 ? "active" : ""} key={index} />)}</div><small>LATENCY {playing ? "180ms" : "—"} / PACKETS {packets || "—"}</small><code className="packet-preview">{packetPreview}</code><div className="recent-packets">{recentPackets.map((sequence) => <span key={sequence}>packet_{sequence.toString().padStart(4, "0")}</span>)}</div></aside></section>
    <footer><span>OPEN AUDIO / OPEN NETWORKS</span><span>SESSION {stationSession} · BUILD 0.0.3</span></footer>
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

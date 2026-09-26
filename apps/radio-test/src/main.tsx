import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const tracks = [
  { time: "NOW", title: "Open frequencies", meta: "Patio transmission / live experiment" },
  { time: "NEXT", title: "A signal looking for a listener", meta: "queued for the next window" },
  { time: "LATER", title: "Night bus through the mempool", meta: "coming soon" },
];

function App() {
  const [playing, setPlaying] = useState(false);
  const [packets, setPackets] = useState(0);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setPackets((value) => value + 1), 900);
    return () => window.clearInterval(timer);
  }, [playing]);
  return <main className="shell">
    <nav><span className="brand"><i /> PATIO</span><span className="nav-note">PUBLIC FREQUENCY / 001</span><span className="clock">TOKYO 02:14</span></nav>
    <section className="hero"><div className="hero-copy"><p className="kicker">PAT.IO RADIO <span>● LIVE TEST</span></p><h1>Information wants<br /><em>to travel.</em></h1><p className="intro">A small station for audio carried across open networks. Tune in while the signal is still experimental.</p></div><div className="station-art"><div className="rings" /><strong>104.2</strong><small>FM / PATIO</small></div></section>
    <section className="player"><div className="play-row"><button className="play" onClick={() => setPlaying(!playing)} aria-label={playing ? "Pause" : "Play"}>{playing ? "Ⅱ" : "▶"}</button><div><p className="overline">{playing ? "NOW PLAYING" : "READY TO TUNE IN"}</p><h2>{playing ? "Open frequencies" : "Patio Radio"}</h2><p className="muted">{playing ? "A test signal from the public mempool" : "The first broadcast is waiting"}</p></div><div className="levels"><b /><b /><b /><b /><b /><b /><b /></div></div><div className="progress"><span /><span /><span /></div><div className="player-meta"><span>00:00</span><span>NO STREAM CONNECTED</span><span>--:--</span></div></section>
    <section className="lower"><div className="schedule"><p className="overline">STATION LOG</p>{tracks.map((track) => <article key={track.time}><time>{track.time}</time><div><strong>{track.title}</strong><small>{track.meta}</small></div><span>↗</span></article>)}</div><aside><p className="overline">SIGNAL STATUS</p><div className="signal"><span /> <strong>{playing ? "RECEIVING" : "LISTENING"}</strong></div><p className="muted">{playing ? "A simulated listener is receiving packets from the station." : "The station is prepared to receive its first packet. This panel will show live network data when the transport is connected."}</p><div className="meter">{Array.from({ length: 10 }, (_, index) => <span className={playing && index < 4 + packets % 6 ? "active" : ""} key={index} />)}</div><small>LATENCY {playing ? "180ms" : "—"} / PACKETS {packets || "—"}</small></aside></section>
    <footer><span>OPEN AUDIO / OPEN NETWORKS</span><span>BUILD 0.0.2</span></footer>
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

"use client";

import { useEffect, useState } from "react";

import {
  type MediaDiagnosticReport,
  type MediaDiagnosticsSession,
} from "../lib/media-diagnostics";

function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null) return "Not observed";
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1_000).toFixed(2)} s`;
}

function formatRate(bytesPerSecond: number): string {
  return `${(bytesPerSecond / 1_024).toFixed(1)} KiB/s`;
}

function downloadReport(report: MediaDiagnosticReport): void {
  const blob = new Blob([JSON.stringify(report, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `patio-${report.identity.role}-diagnostics-${report.identity.runId}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function MediaDiagnosticsPanel({
  session,
}: {
  session: MediaDiagnosticsSession;
}) {
  const [report, setReport] = useState(() => session.snapshot());

  useEffect(() => {
    setReport(session.snapshot());
    const timer = window.setInterval(() => {
      setReport(session.snapshot());
    }, 750);
    return () => window.clearInterval(timer);
  }, [session]);

  const { summary } = report;
  const broadcaster = report.identity.role === "broadcaster";

  return (
    <details className="media-diagnostics">
      <summary>
        <span>Diagnóstico de emisión</span>
        <span aria-hidden="true">⌄</span>
      </summary>
      <div className="media-diagnostics__body">
        <dl aria-label="Métricas de esta sesión">
          {broadcaster ? (
            <>
              <div>
                <dt>Generación / envío</dt>
                <dd>
                  {formatRate(summary.generatedBytesPerSecond)} ·{" "}
                  {summary.sentPacketsPerSecond.toFixed(2)} tx/s
                </dd>
              </div>
              <div>
                <dt>Cola</dt>
                <dd>
                  {summary.queueDepth} ahora · máx. {summary.maximumQueueDepth}{" "}
                  · {formatDuration(summary.oldestQueueAgeMs)} más antiguo
                </dd>
              </div>
              <div>
                <dt>Observación por polling</dt>
                <dd>
                  {formatDuration(summary.meanPollingObservationMs)} ·{" "}
                  {summary.packetsObserved}/{summary.packetsAttempted} paquetes
                </dd>
              </div>
              <div>
                <dt>Segmentos</dt>
                <dd>
                  {summary.segments} · {summary.fragments} fragmentos ·{" "}
                  {summary.discardedSegments} descartados
                  {summary.unsentTrailingChunks > 0
                    ? ` · ${summary.unsentTrailingBytes} B finales no enviados`
                    : ""}
                </dd>
              </div>
            </>
          ) : (
            <>
              <div>
                <dt>Primera reproducción</dt>
                <dd>
                  {formatDuration(summary.playRequestToPlaybackMs)} desde Play ·{" "}
                  {formatDuration(summary.startupMs)} desde apertura
                </dd>
              </div>
              <div>
                <dt>Buffer continuo</dt>
                <dd>{summary.bufferAheadSeconds.toFixed(2)} s por delante</dd>
              </div>
              <div>
                <dt>Interrupciones</dt>
                <dd>
                  {summary.interruptions} ·{" "}
                  {formatDuration(summary.interruptionDurationMs)}
                </dd>
              </div>
              <div>
                <dt>Posicionamiento / saltos</dt>
                <dd>
                  {summary.initialPositioningSeeks} inicial ·{" "}
                  {summary.midPlaybackSeeks} durante reproducción ·{" "}
                  {summary.midPlaybackSeekSeconds.toFixed(2)} s omitidos
                </dd>
              </div>
              <div>
                <dt>Final</dt>
                <dd>
                  {summary.transportEnded ? "transporte terminado" : "en vivo"}
                  {summary.playbackEnded
                    ? ` · reproducción terminada · ${formatDuration(summary.postTransportDrainMs)} de drenaje`
                    : " · contenido pendiente"}
                </dd>
              </div>
              <div>
                <dt>Recepción</dt>
                <dd>
                  {summary.observedSequenceGaps} huecos observados ·{" "}
                  {summary.duplicates} duplicados · {summary.invalidPackets}{" "}
                  inválidos
                </dd>
              </div>
              <div>
                <dt>Vídeo / estado</dt>
                <dd>
                  {summary.presentedFrames ?? "—"} frames presentados ·{" "}
                  {summary.playbackState}
                </dd>
              </div>
            </>
          )}
          <div>
            <dt>Errores</dt>
            <dd>
              {summary.errors + summary.pollErrors + summary.appendsFailed}
            </dd>
          </div>
        </dl>
        <p>
          Describe solo esta sesión. Las duraciones usan el reloj local del
          navegador; no son latencia exacta entre dispositivos.
        </p>
        <button
          className="secondary-action"
          type="button"
          onClick={() => downloadReport(session.snapshot())}
        >
          Exportar metadata JSON
        </button>
      </div>
    </details>
  );
}

import { useSyncExternalStore } from 'react'
import styled from 'styled-components'
import {
  DEPTH_INFO,
  depthReport,
  describeDepthPrecision,
  type DepthReport,
  type DepthRtProbe,
  reversedFloatDepth,
  subscribeDepthPrecision,
} from './depth-precision'

/**
 * ?depth=info (tides-zmw.9.4): what this device's depth buffer stores, as
 * selectable text for a phone screenshot or a copy, and as data-* attributes
 * for headless checks. Renders nothing without the flag.
 */
export function DepthInfo() {
  const report = useSyncExternalStore(subscribeDepthPrecision, depthReport, depthReport)
  if (!DEPTH_INFO) return null
  return <DepthInfoPanel report={report} />
}

const targetLine = (t: DepthRtProbe) =>
  'error' in t ? `${t.name} error` : `${t.name} ${describeDepthPrecision(t)}`

export function DepthInfoPanel({ report }: { report: DepthReport | null }) {
  if (!report) {
    return (
      <Panel open data-depth-info="pending">
        <summary>Depth: probing…</summary>
      </Panel>
    )
  }
  const { precision: p } = report
  const floatDepth = reversedFloatDepth({ capabilities: { reversedDepthBuffer: report.reversed } }, p)
  return (
    <Panel
      open
      data-depth-info="done"
      data-kind={p.kind}
      data-bits={p.bits}
      data-max-k={p.maxPassK}
      data-ms={p.ms}
      data-reversed={report.reversed}
      data-reversed-float={floatDepth}
      data-clip-control={report.clipControl}
      data-depth-bits={report.depthBits}
      data-component-type={report.componentType}
      data-targets={report.targets.map(targetLine).join('; ')}
    >
      <summary>
        Depth: {report.reversed ? 'reversed' : 'standard'}, {describeDepthPrecision(p)}
      </summary>
      <dl>
        <dt>canyon floor</dt>
        <dd>{floatDepth ? 'yes (reversed + float)' : 'no'}</dd>
        <dt>probe</dt>
        <dd>{p.ms} ms</dd>
        <dt>clip control</dt>
        <dd>{report.clipControl ? 'yes' : 'no'}</dd>
        <dt>reported</dt>
        <dd>
          DEPTH_BITS {report.depthBits}, STENCIL_BITS {report.stencilBits}, {report.componentType}
        </dd>
        <dt>context</dt>
        <dd>
          antialias {report.antialias ? 'on' : 'off'}, stencil {report.stencil ? 'on' : 'off'}
        </dd>
        <dt>targets</dt>
        <dd>
          {report.targets.map((t) => (
            <span key={t.name}>
              {targetLine(t)}
              <br />
            </span>
          ))}
        </dd>
        <dt>GPU</dt>
        <dd>{report.renderer}</dd>
        <dt>buffer</dt>
        <dd>
          {report.drawingBuffer} @{report.pixelRatio}x
        </dd>
        <dt>browser</dt>
        <dd>{report.userAgent}</dd>
      </dl>
    </Panel>
  )
}

// Under the ship's top row (exit and help buttons, then the HUD strip, two
// rows deep on a phone: ~140 px) and the folded dock's button, over the sky;
// the summary folds it away. A 390 px phone gets the full width less the
// insets.
const PANEL_TOP = 'calc(var(--dock-top) + 152px)'
const Panel = styled.details`
  position: fixed;
  top: ${PANEL_TOP};
  left: var(--dock-inset-left);
  z-index: 20;
  box-sizing: border-box;
  width: 360px;
  max-width: calc(100vw - var(--dock-inset-left) - var(--dock-inset-right));
  max-height: calc(100dvh - ${PANEL_TOP} - 16px);
  overflow: auto;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.78);
  color: #fff;
  font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
  user-select: text;
  -webkit-user-select: text;
  pointer-events: auto;

  summary {
    cursor: pointer;
    font-weight: 600;
  }

  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 2px 8px;
    margin: 6px 0 0;
  }

  dt {
    color: rgba(255, 255, 255, 0.6);
  }

  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
`

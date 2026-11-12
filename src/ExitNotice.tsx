import { useSyncExternalStore } from 'react'
import styled from 'styled-components'
import {
  currentExitReport,
  dismissExitReport,
  exitDetails,
  showsNotice,
  subscribeExitReport,
} from './exit-watch'

/**
 * The last load in this tab ended without pagehide while on screen, moments
 * ago (tides-8h7.4): most likely the browser killed the page. Shown only for
 * such a foreground kill (exit-watch.ts showsNotice); a background one (iOS
 * drops hidden tabs routinely) or an old one is logged to the console alone.
 */
export function ExitNotice() {
  const report = useSyncExternalStore(subscribeExitReport, currentExitReport, currentExitReport)
  if (!report || !showsNotice(report)) return null
  return (
    <Notice role="status" data-exit-kind={report.kind}>
      <details>
        <summary>This page reloaded unexpectedly, probably because the browser ran low on memory.</summary>
        <dl>
          {exitDetails(report).map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </details>
      <button type="button" aria-label="Dismiss reload notice" onClick={dismissExitReport}>
        ×
      </button>
    </Notice>
  )
}

// Where DepthInfo's panel sits (renderers/DepthInfo.tsx): under the ship's
// top row and the folded dock's button. Over it (z-index) with ?depth=info.
const NOTICE_TOP = 'calc(var(--dock-top) + 152px)'
const Notice = styled.div`
  position: fixed;
  top: ${NOTICE_TOP};
  left: var(--dock-inset-left);
  z-index: 21;
  box-sizing: border-box;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 360px;
  max-width: calc(100vw - var(--dock-inset-left) - var(--dock-inset-right));
  max-height: calc(100dvh - ${NOTICE_TOP} - 16px);
  overflow: auto;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.78);
  color: #fff;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.35;
  user-select: text;
  -webkit-user-select: text;
  pointer-events: auto;

  details {
    flex: 1;
    min-width: 0;
  }

  summary {
    cursor: pointer;
    font-weight: 600;
  }

  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 2px 8px;
    margin: 6px 0 0;
    font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  dl > div {
    display: contents;
  }

  dt {
    color: rgba(255, 255, 255, 0.6);
  }

  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  /* A 44 px target; the negative margin keeps it inside the padding's look. */
  button {
    flex: none;
    width: 44px;
    height: 44px;
    margin: -8px -10px -8px 0;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
  }
`

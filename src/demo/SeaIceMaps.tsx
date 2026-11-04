// The seasons readout's sea ice (tides-zec.19): the Arctic and the Antarctic
// seen from above on the sim date's day of the year, side by side, each with
// its ice extent, both on the tour's clock. The maps are sea-ice-map.ts's,
// drawn on canvases whenever the readout's hourly timestamp moves.
import { useEffect, useMemo, useRef } from 'react'
import styled from 'styled-components'
import { NORTH_GRID, SOUTH_GRID, extentOn, seaIceDataDate, seaIceDay, seaIceFrames, type IceGrid, type PolarGrid } from './sea-ice'
import { drawPolarMap, polarMapLayout } from './sea-ice-map'
import type { SeaIceData } from './sea-ice-data'
import { sunForSeasons } from './seasons'
import { PHONE_VIEW_PX } from '../system-aids/label-style'

/** The canvases' pixels across; CSS scales them to the readout's em. */
const MAP_PX = 192

interface PolarMapProps {
  data: SeaIceData
  grid: PolarGrid
  ice: IceGrid
  timestamp: number
  dec: number
  label: string
}

function PolarMap({ data, grid, ice, timestamp, dec, label }: PolarMapProps) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const layout = useMemo(() => polarMapLayout(grid, data.mask, MAP_PX), [grid, data.mask])
  const image = useMemo(() => (typeof ImageData === 'undefined' ? null : new ImageData(MAP_PX, MAP_PX)), [])
  useEffect(() => {
    const context = canvas.current?.getContext('2d')
    if (!context || !image) return
    const { a, b, mix } = seaIceFrames(seaIceDay(timestamp), data.ice.stepDays, ice.frames.length)
    drawPolarMap(layout, ice, a, b, mix, dec, image.data)
    context.putImageData(image, 0, 0)
  }, [layout, ice, image, timestamp, dec, data.ice.stepDays])
  return <Disc ref={canvas} width={MAP_PX} height={MAP_PX} role="img" aria-label={label} />
}

function extentText(million: number): string {
  // Kept whole when the caption wraps beside a phone's map.
  return `${million.toFixed(1)} million\u00a0km²`
}

export function SeaIceMaps({ data, timestamp }: { data: SeaIceData; timestamp: number }) {
  const { ice } = data
  const day = seaIceDay(timestamp)
  const { dec } = sunForSeasons(timestamp)
  const north = extentOn(ice.extentNorth, day)
  const south = extentOn(ice.extentSouth, day)
  return (
    <Section aria-label="Sea ice">
      <Maps>
        <Figure>
          <PolarMap data={data} grid={NORTH_GRID} ice={ice.north} timestamp={timestamp} dec={dec} label="Map of the Arctic’s sea ice" />
          <figcaption>
            Arctic <strong>{extentText(north)}</strong>
          </figcaption>
        </Figure>
        <Figure>
          <PolarMap data={data} grid={SOUTH_GRID} ice={ice.south} timestamp={timestamp} dec={dec} label="Map of the sea ice around Antarctica" />
          <figcaption>
            Antarctic <strong>{extentText(south)}</strong>
          </figcaption>
        </Figure>
      </Maps>
      <Note>
        White: sea ice, from satellites on {seaIceDataDate(timestamp, ice.year)}. Dark: little or no sunlight.
      </Note>
    </Section>
  )
}

const Section = styled.section`
  margin: 8px 0 0;
`

const Maps = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  column-gap: 0.75em;
`

// On a phone (index.css's breakpoint) each map is smaller with its caption
// beside it, so the readout leaves the orbit room below.
const PHONE = `@media only screen and (max-width: ${PHONE_VIEW_PX}px)`

const Figure = styled.figure`
  margin: 0;
  display: flex;
  flex-direction: column;
  align-items: center;

  figcaption {
    margin-top: 3px;
    text-align: center;
    font-size: 0.92em;
    color: rgba(255, 255, 255, 0.75);
  }

  strong {
    display: block;
    color: #fff;
    font-weight: 600;
  }

  ${PHONE} {
    flex-direction: row;
    column-gap: 0.5em;

    figcaption {
      margin-top: 0;
      text-align: left;
    }
  }
`

const Disc = styled.canvas`
  display: block;
  width: min(100%, 8.5em);
  aspect-ratio: 1;

  ${PHONE} {
    flex: none;
    width: 5.5em;
  }
`

const Note = styled.p`
  margin: 5px 0 0;
  color: rgba(255, 255, 255, 0.6);
  font-size: 0.83em;
`

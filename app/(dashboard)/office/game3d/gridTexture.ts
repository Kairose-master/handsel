'use client'

/**
 * A small tileable "blueprint grid" texture, generated on a canvas rather
 * than imported as an asset — same "no hand-authored art" rule the rest of
 * game3d/ follows for geometry. Purely decorative (floor readability at the
 * tactical-telemetry aesthetic), cached per base/line color pair so the
 * nine department rooms sharing a kind reuse one GPU texture instead of
 * generating nine.
 */
import * as THREE from 'three'

const cache = new Map<string, THREE.Texture>()

export function gridTexture(base: string, line: string): THREE.Texture {
  const key = `${base}|${line}`
  const hit = cache.get(key)
  if (hit) return hit

  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = base
  ctx.fillRect(0, 0, size, size)
  ctx.strokeStyle = line
  ctx.lineWidth = 1
  ctx.strokeRect(0.5, 0.5, size - 1, size - 1)
  ctx.beginPath()
  ctx.moveTo(size / 2, 0)
  ctx.lineTo(size / 2, size)
  ctx.moveTo(0, size / 2)
  ctx.lineTo(size, size / 2)
  ctx.globalAlpha = 0.35
  ctx.stroke()

  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  cache.set(key, tex)
  return tex
}

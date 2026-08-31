<script lang="ts">
// Cursor art comes from `$parent/retreeved/sharedAssets` — retreeved/ is the SINGLE
// SOURCE OF TRUTH for shared art. It used to be the static URL
// `/mobileAssets/...`, which only resolves on this server, so a child or
// any other tier reusing the same hand had to keep its own second copy.
// Importing binds the bytes to the build instead of to one host's URL.
import handShovelCursor100 from "$gc/assets/hand_shovel_cursor_100.webp";

// Guided draw-tour hand cursor for the map page. Presentational + imperative:
// it holds the hand_shovel_cursor sprite and exposes async motion primitives
// (fadeIn, moveTo along a gentle curve, tap, pad, fadeOut) that
// MapDrawControls choreographs into the "here's how to draw" idle demo.
//
// Coordinates are FRAME-LOCAL px (the caller subtracts the .mobile-preview-frame
// rect on dt-web; on native/mob-web the frame rect is {0,0} so they're
// viewport px). The sprite is position:fixed, which resolves to the phone
// frame on dt-web (it has `contain: layout`) and the viewport on device.

// ── TUNING KNOBS ──────────────────────────────────────────────────────────
const HAND_H = 104; // px — rendered hand height
// Where the pointing fingertip sits inside the image, as a fraction of the
// rendered box (0,0 = top-left). The asset points up-left, so the tip is near
// the top-left corner. Nudge these if the tip doesn't kiss the target.
const TIP_X = 0.2;
const TIP_Y = 0.08;

let visible = $state(false);
let fx = $state(0); // fingertip target x (frame-local px)
let fy = $state(0); // fingertip target y
let rot = $state(0);
let scale = $state(1);
let opacity = $state(0);

let gsapLib: typeof import("gsap").gsap | null = null;
import("gsap").then((m) => (gsapLib = m.gsap));
async function G() {
	return gsapLib ?? (await import("gsap")).gsap;
}

let live: { kill?: () => void }[] = [];
function track<T extends { kill?: () => void }>(t: T): T {
	live.push(t);
	return t;
}

export function isVisible(): boolean {
	return visible;
}

// Drop the hand in (hidden) at a fingertip position, ready to fade in.
export function place(x: number, y: number, r = 0): void {
	fx = x;
	fy = y;
	rot = r;
	scale = 1;
	opacity = 0;
	visible = true;
}

export async function fadeIn(duration = 0.3): Promise<void> {
	const g = await G();
	const p = { o: opacity };
	await track(
		g.to(p, {
			o: 1,
			duration,
			ease: "power2.out",
			onUpdate: () => {
				opacity = p.o;
			},
		}),
	);
}

export async function fadeOut(duration = 0.3): Promise<void> {
	const g = await G();
	const p = { o: opacity };
	await track(
		g.to(p, {
			o: 0,
			duration,
			ease: "power2.in",
			onUpdate: () => {
				opacity = p.o;
			},
		}),
	);
}

// Glide the fingertip to (x,y) along a gentle quadratic curve. `curve` is the
// perpendicular bow in px (sign flips which way it arcs); 0 = straight line.
export async function moveTo(
	x: number,
	y: number,
	opts: { curve?: number; rot?: number; duration?: number; ease?: string } = {},
): Promise<void> {
	const g = await G();
	const sx = fx,
		sy = fy,
		sr = rot;
	const tr = opts.rot ?? rot;
	const curve = opts.curve ?? 0;
	const mx = (sx + x) / 2,
		my = (sy + y) / 2;
	const dx = x - sx,
		dy = y - sy;
	const len = Math.hypot(dx, dy) || 1;
	const nx = -dy / len,
		ny = dx / len; // unit perpendicular
	const cx = mx + nx * curve,
		cy = my + ny * curve;
	const p = { t: 0 };
	await track(
		g.to(p, {
			t: 1,
			duration: opts.duration ?? 1,
			ease: opts.ease ?? "power2.inOut",
			onUpdate: () => {
				const t = p.t,
					m = 1 - t;
				fx = m * m * sx + 2 * m * t * cx + t * t * x;
				fy = m * m * sy + 2 * m * t * cy + t * t * y;
				rot = sr + (tr - sr) * t;
			},
		}),
	);
}

// Quick press: dip the scale and spring back (a tap on a button).
export async function tap(): Promise<void> {
	const g = await G();
	const p = { s: 1 };
	const setScale = () => {
		scale = p.s;
	};
	await track(
		g.to(p, { s: 0.82, duration: 0.12, ease: "power2.in", onUpdate: setScale }),
	);
	await track(g.to(p, { s: 1, duration: 0.16, ease: "back.out(2)", onUpdate: setScale }));
}

// Tickle a spot: slide the fingertip back and forth across (x,y) a few times.
export async function pad(
	x: number,
	y: number,
	opts: { times?: number; amp?: number; duration?: number } = {},
): Promise<void> {
	const g = await G();
	const times = opts.times ?? 3;
	const amp = opts.amp ?? 11;
	const dur = opts.duration ?? 0.26;
	fy = y;
	for (let i = 0; i < times; i++) {
		const sign = i % 2 === 0 ? 1 : -1;
		const p = { d: 0 };
		await track(
			g.to(p, {
				d: 1,
				duration: dur,
				ease: "sine.inOut",
				onUpdate: () => {
					fx = x + Math.sin(p.d * Math.PI) * amp * sign;
				},
			}),
		);
	}
	fx = x;
}

export function cancel(): void {
	for (const t of live)
		try {
			t.kill?.();
		} catch {
			/* tween already disposed */
		}
	live = [];
	visible = false;
	opacity = 0;
}
</script>

{#if visible}
	<img
		class="draw-demo-hand"
		src={handShovelCursor100}
		alt=""
		aria-hidden="true"
		style="left:{fx}px; top:{fy}px; height:{HAND_H}px; opacity:{opacity};
		       transform-origin: {TIP_X * 100}% {TIP_Y * 100}%;
		       transform: translate(-{TIP_X * 100}%, -{TIP_Y * 100}%) rotate({rot}deg) scale({scale});"
	/>
{/if}

<style>
	.draw-demo-hand {
		position: fixed;
		z-index: 60;
		pointer-events: none;
		width: auto;
		filter: drop-shadow(0 6px 12px rgba(0, 0, 0, 0.55));
		will-change: transform, left, top, opacity;
	}
</style>

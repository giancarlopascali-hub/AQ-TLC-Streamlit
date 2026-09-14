/**
 * @module constants
 * @file modules/constants.js
 *
 * Shared geometry and configuration constants for AQ-TLC.
 *
 * â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”
 * Rf COORDINATE SYSTEM â€” READ THIS BEFORE EDITING
 * â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”
 * The lane bounding box is intentionally drawn 10% LARGER than the physical
 * Origin-to-Front distance, providing 5% padding above the Front line and
 * 5% padding below the Origin line.  Within this box (total height = 1.10Ã—):
 *
 *   â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”  â† top of box (Front side)
 *   â”‚  5% pad         â”‚  (0.05 / 1.10 from top)
 *   â”œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¤  â† FRONT line  (Rf = 1.0)
 *   â”‚                 â”‚
 *   â”‚   active Rf     â”‚  (spans 1.00 / 1.10 of box)
 *   â”‚   region        â”‚
 *   â”œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¤  â† ORIGIN line (Rf = 0.0)
 *   â”‚  5% pad         â”‚  (0.05 / 1.10 from bottom)
 *   â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜  â† bottom of box (Origin side)
 *
 * RF_ORIGIN_OFFSET = 1.05 / 1.10  â‰ˆ 0.9545  (fractional Y of Origin in box)
 * RF_FRONT_OFFSET  = 0.05 / 1.10  â‰ˆ 0.0455  (fractional Y of Front in box)
 *
 * These values MUST stay identical to the y_origin_line / y_front_line
 * constants used in generate_profiles() in server.py.
 */

// â”€â”€ Rf geometry â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Fractional position of the Origin line (Rf=0) within the lane bounding box. */
export const RF_ORIGIN_OFFSET = 1.05 / 1.10;   // â‰ˆ 0.9545

/** Fractional position of the Front line (Rf=1) within the lane bounding box. */
export const RF_FRONT_OFFSET  = 0.05 / 1.10;   // â‰ˆ 0.0455

/** Total calibrated Rf span (Origin â†’ Front) within the box. */
export const RF_SPAN = RF_ORIGIN_OFFSET - RF_FRONT_OFFSET; // â‰ˆ 0.9090

// â”€â”€ Peak detection slider defaults â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Default Sensitivity (prominence) slider value (1â€“80 scale). */
export const DEFAULT_PEAK_PROMINENCE = 40;

/** Default Resolution (min-distance) slider value. */
export const DEFAULT_PEAK_DISTANCE = 8;

/** Default Width-% (integration half-width threshold) slider value. */
export const DEFAULT_PEAK_THRESHOLD = 50;

// â”€â”€ Undo stack â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Maximum number of snapshots held in the undo stack before FIFO eviction. */
export const UNDO_STACK_LIMIT = 50;

// â”€â”€ Server communication â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Gaussian smoothing sigma applied server-side to the raw density profile.
 * Increasing this value reduces noise but may broaden narrow peaks.
 * This is currently fixed and not exposed in the UI.
 */
export const SMOOTH_SIGMA = 1.5;

// â”€â”€ Canvas interaction â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Maximum vertical distance in scaled canvas pixels within which a spotting
 * mark will snap horizontally onto the nearest Origin line.
 */
export const SNAP_THRESHOLD_PX = 150;

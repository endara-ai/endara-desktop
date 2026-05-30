//! Tray icon compositing for the health indicator.
//!
//! The base tray icon is the existing monochrome template PNG. At runtime we
//! decode it, paint a small filled circle in the bottom-right corner using one
//! of the macOS system colors (green / yellow / red), and re-encode the result
//! as PNG. The pre-built variants are stashed in [`TrayIcons`] and stored as
//! managed state so the `set_tray_health` Tauri command can swap icons cheaply.

use image::ImageEncoder;

/// macOS system green (`#34C759`).
pub const DOT_GREEN: [u8; 4] = [52, 199, 89, 255];
/// macOS system orange/amber (`#FF9500`).
pub const DOT_YELLOW: [u8; 4] = [255, 149, 0, 255];
/// macOS system red (`#FF3B30`).
pub const DOT_RED: [u8; 4] = [255, 59, 48, 255];

/// Cached PNG bytes for every tray icon variant.
pub struct TrayIcons {
    pub base: Vec<u8>,
    pub healthy: Vec<u8>,
    pub degraded: Vec<u8>,
    pub down: Vec<u8>,
}

/// Build all four variants from the base template PNG.
pub fn build_tray_icons(base: &[u8]) -> TrayIcons {
    TrayIcons {
        base: base.to_vec(),
        healthy: tray_icon_with_dot(base, DOT_GREEN),
        degraded: tray_icon_with_dot(base, DOT_YELLOW),
        down: tray_icon_with_dot(base, DOT_RED),
    }
}

/// Composite a filled circle onto the bottom-right corner of the base tray
/// icon and return PNG-encoded bytes.
///
/// The dot is sized at ~17% of the icon width with a 2px edge padding so it
/// remains visible at both 22×22 and 44×44 (`@2x`) renderings without
/// crowding the glyph.
pub fn tray_icon_with_dot(base: &[u8], dot_color: [u8; 4]) -> Vec<u8> {
    let mut img = image::load_from_memory(base)
        .expect("tray base icon must be a decodable PNG")
        .to_rgba8();
    recolor_glyph_to_white(&mut img);
    let (w, h) = (img.width(), img.height());
    let dot_radius = ((w as f32) * 0.17).round().max(2.0) as i32;
    let cx = (w as i32) - dot_radius - 2;
    let cy = (h as i32) - dot_radius - 2;

    for y in (cy - dot_radius)..=(cy + dot_radius) {
        for x in (cx - dot_radius)..=(cx + dot_radius) {
            if x < 0 || y < 0 || x >= w as i32 || y >= h as i32 {
                continue;
            }
            let dx = x - cx;
            let dy = y - cy;
            if dx * dx + dy * dy <= dot_radius * dot_radius {
                img.put_pixel(x as u32, y as u32, image::Rgba(dot_color));
            }
        }
    }

    let mut buf = Vec::new();
    image::codecs::png::PngEncoder::new(&mut buf)
        .write_image(
            img.as_raw(),
            img.width(),
            img.height(),
            image::ExtendedColorType::Rgba8,
        )
        .expect("re-encode tray icon as PNG");
    buf
}

/// Repaint every visible pixel of `img` to opaque white, preserving its alpha
/// channel. The tray base PNG ships as a black-pixel template so macOS can
/// auto-invert it on the menu bar; for the colored (non-template) variants we
/// pre-invert it ourselves so the glyph stays legible on the dark menu bar.
fn recolor_glyph_to_white(img: &mut image::RgbaImage) {
    for pixel in img.pixels_mut() {
        if pixel.0[3] > 0 {
            pixel.0[0] = 255;
            pixel.0[1] = 255;
            pixel.0[2] = 255;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &[u8] = include_bytes!("../icons/tray-icon-template.png");

    fn decode(png: &[u8]) -> image::RgbaImage {
        image::load_from_memory(png)
            .expect("decode composited png")
            .to_rgba8()
    }

    #[test]
    fn dot_center_uses_requested_color() {
        let out = tray_icon_with_dot(BASE, DOT_GREEN);
        let img = decode(&out);
        let (w, h) = (img.width() as i32, img.height() as i32);
        let r = ((w as f32) * 0.17).round().max(2.0) as i32;
        let cx = (w - r - 2) as u32;
        let cy = (h - r - 2) as u32;
        let px = img.get_pixel(cx, cy).0;
        assert_eq!(px, DOT_GREEN, "center pixel should be the dot fill color");
    }

    #[test]
    fn variants_differ_in_color_at_dot_center() {
        let icons = build_tray_icons(BASE);
        let h = decode(&icons.healthy);
        let d = decode(&icons.degraded);
        let r = decode(&icons.down);
        let w = h.width() as i32;
        let height = h.height() as i32;
        let radius = ((w as f32) * 0.17).round().max(2.0) as i32;
        let cx = (w - radius - 2) as u32;
        let cy = (height - radius - 2) as u32;
        assert_eq!(h.get_pixel(cx, cy).0, DOT_GREEN);
        assert_eq!(d.get_pixel(cx, cy).0, DOT_YELLOW);
        assert_eq!(r.get_pixel(cx, cy).0, DOT_RED);
        assert_eq!(icons.base, BASE);
    }

    #[test]
    fn dot_has_no_border_ring() {
        let out = tray_icon_with_dot(BASE, DOT_GREEN);
        let img = decode(&out);
        let (w, h) = (img.width() as i32, img.height() as i32);
        let dot_radius = ((w as f32) * 0.17).round().max(2.0) as i32;
        let cx = w - dot_radius - 2;
        let cy = h - dot_radius - 2;
        let edge_x = (cx + dot_radius - 1) as u32;
        let edge_y = cy as u32;
        let px = img.get_pixel(edge_x, edge_y).0;
        assert_eq!(
            px, DOT_GREEN,
            "pixel just inside the dot boundary must be the pure fill color (no border ring)",
        );
    }

    #[test]
    fn pixel_outside_dot_is_untouched() {
        let base_img = decode(BASE);
        let out = tray_icon_with_dot(BASE, DOT_RED);
        let img = decode(&out);
        let p_orig = base_img.get_pixel(0, 0).0;
        let p_new = img.get_pixel(0, 0).0;
        assert_eq!(
            p_orig, p_new,
            "top-left pixel far from the dot must be unchanged"
        );
    }

    #[test]
    fn glyph_is_recolored_to_white_in_colored_variants() {
        let base_img = decode(BASE);
        let (w, h) = (base_img.width() as i32, base_img.height() as i32);
        let dot_radius = ((w as f32) * 0.17).round().max(2.0) as i32;
        let dot_cx = w - dot_radius - 2;
        let dot_cy = h - dot_radius - 2;

        // Find an originally-opaque glyph pixel that's well outside the dot
        // composite area so the recolor — not the dot — is what we assert on.
        let dot_keepout = (dot_radius + 2) as f32;
        let (gx, gy) = (0..base_img.height())
            .flat_map(|y| (0..base_img.width()).map(move |x| (x, y)))
            .find(|&(x, y)| {
                let px = base_img.get_pixel(x, y).0;
                if px[3] == 0 {
                    return false;
                }
                let dx = x as f32 - dot_cx as f32;
                let dy = y as f32 - dot_cy as f32;
                (dx * dx + dy * dy).sqrt() > dot_keepout
            })
            .expect("base icon must contain at least one opaque glyph pixel outside the dot area");

        let healthy = decode(&tray_icon_with_dot(BASE, DOT_GREEN));
        let recolored = healthy.get_pixel(gx, gy).0;
        assert_eq!(
            (recolored[0], recolored[1], recolored[2]),
            (255, 255, 255),
            "originally-opaque glyph pixel must be repainted to white",
        );
        assert!(
            recolored[3] > 0,
            "recolor must preserve the original alpha (>0) of the glyph pixel",
        );

        let dot_px = healthy.get_pixel(dot_cx as u32, dot_cy as u32).0;
        assert_eq!(
            dot_px, DOT_GREEN,
            "bottom-right dot center must still be the healthy green fill",
        );
    }
}

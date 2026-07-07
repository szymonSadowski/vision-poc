// All shader sources live here as plain strings — avoids extra Vite loader
// config for .glsl imports, keeps the pipeline's uniform wiring next to the
// GLSL it targets.

export const VERT_FULLSCREEN = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Pass 1: refraction blur — elliptical multi-tap kernel.
// Combines myopia/hyperopia/presbyopia/cataract-blur as an isotropic radius
// and astigmatism as anisotropic (major/minor axis + angle) stretch on top.
// A point light run through this becomes a streak/blob per the astigmatism
// visual-target table in requirements §3.
// ---------------------------------------------------------------------------
export const FRAG_REFRACTION_BLUR = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uTexelSize;   // 1/width, 1/height in source pixels
uniform float uRadiusX;    // major axis radius, in source pixels
uniform float uRadiusY;    // minor axis radius, in source pixels
uniform float uAngle;      // axis angle, radians

// 16-tap poisson-ish ring + center, cheap approximation of a gaussian
// disk — good enough for perceptual blur at real-time frame budgets.
const int TAP_COUNT = 16;

void main() {
  if (uRadiusX < 0.05 && uRadiusY < 0.05) {
    fragColor = texture(uSource, vUv);
    return;
  }

  float c = cos(uAngle);
  float s = sin(uAngle);

  vec4 sum = texture(uSource, vUv);
  float weightSum = 1.0;

  for (int i = 0; i < TAP_COUNT; i++) {
    float t = float(i) / float(TAP_COUNT);
    float ring = float(i % 4 == 0 ? 1 : 0); // vary radius a little per ring
    float rScale = 0.55 + 0.45 * ring;
    float theta = t * 6.28318530718 * 3.0; // spiral through several turns
    float rx = uRadiusX * rScale * sqrt(t + 0.05);
    float ry = uRadiusY * rScale * sqrt(t + 0.05);

    // offset in the blur's local (major/minor) frame
    vec2 local = vec2(cos(theta) * rx, sin(theta) * ry);
    // rotate into image space by the astigmatism axis angle
    vec2 rotated = vec2(local.x * c - local.y * s, local.x * s + local.y * c);
    vec2 offset = rotated * uTexelSize;

    float w = 1.0 - t * 0.35; // gently taper contribution of outer taps
    sum += texture(uSource, vUv + offset) * w;
    weightSum += w;
  }

  fragColor = sum / weightSum;
}
`;

// ---------------------------------------------------------------------------
// Pass 2: bright threshold extraction (for glare/halo bloom chain).
// Runs on the *unblurred* source so halos stay keyed to real bright regions.
// ---------------------------------------------------------------------------
export const FRAG_THRESHOLD = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform float uThreshold; // 0-1 luminance cutoff
uniform float uSoftness;  // knee softness above threshold

void main() {
  vec4 c = texture(uSource, vUv);
  float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  float bright = smoothstep(uThreshold, uThreshold + uSoftness, lum);
  fragColor = vec4(c.rgb * bright, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Separable gaussian blur (one direction per draw call). Reused for both the
// "narrow" and "wide" bloom taps that get differenced into a halo ring, and
// for the veiling-glare wide blur.
// ---------------------------------------------------------------------------
export const FRAG_BLUR_1D = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uDirection; // normalized direction * texel size, pre-scaled by caller
uniform float uRadius;   // taps count scale

void main() {
  // 9-tap gaussian, weights approximating sigma ~ uRadius/2
  float weights[5];
  weights[0] = 0.227027;
  weights[1] = 0.1945946;
  weights[2] = 0.1216216;
  weights[3] = 0.054054;
  weights[4] = 0.016216;

  vec3 result = texture(uSource, vUv).rgb * weights[0];
  for (int i = 1; i < 5; i++) {
    vec2 off = uDirection * (float(i) * uRadius);
    result += texture(uSource, vUv + off).rgb * weights[i];
    result += texture(uSource, vUv - off).rgb * weights[i];
  }
  fragColor = vec4(result, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Final composite pass: combines refraction-blurred base + glare/halo bloom,
// applies cataract color grading (contrast compression + yellowing), and
// resolves the view mode (normal / before-after slider / split screen).
// ---------------------------------------------------------------------------
export const FRAG_COMPOSITE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uBase;       // refraction-blurred frame
uniform sampler2D uRaw;        // untouched source frame (for before/after)
uniform sampler2D uBloomNarrow;
uniform sampler2D uBloomWide;

uniform float uGlareIntensity;
uniform vec3 uGlareTint;
uniform float uHaloIntensity;
uniform vec3 uHaloTint;

uniform float uContrastIntensity;
uniform float uFogAmount;      // fog variant: whitish veil mix
uniform float uLowLightAmount; // low-light variant: darken + desaturate before compressing

uniform float uYellowIntensity;

uniform int uViewMode;   // 0 normal, 1 before/after, 2 split
uniform float uSplitPos; // 0-1

vec3 applyContrastAndFog(vec3 color) {
  // Low-light variant: darken & desaturate first (rods-only look at night).
  if (uLowLightAmount > 0.0) {
    float g = dot(color, vec3(0.299, 0.587, 0.114));
    color = mix(color, vec3(g) * 0.85, uLowLightAmount);
    color *= mix(1.0, 0.75, uLowLightAmount);
  }
  // Contrast compression: pull toward mid-gray and lift blacks instead of
  // simply darkening, per requirements §6.
  if (uContrastIntensity > 0.0) {
    vec3 lifted = color * 0.72 + 0.14;
    color = mix(color, lifted, uContrastIntensity);
  }
  // Fog variant: additive whitish veil, scene-brightness independent.
  if (uFogAmount > 0.0) {
    color = mix(color, vec3(0.85, 0.86, 0.88), uFogAmount * 0.5);
  }
  return color;
}

vec3 applyYellowing(vec3 color) {
  vec3 yellowTint = vec3(1.0, 0.92, 0.62); // lens yellowing cuts blue transmission
  return mix(color, color * yellowTint, uYellowIntensity);
}

void main() {
  vec3 base = texture(uBase, vUv).rgb;

  vec3 bloomWide = texture(uBloomWide, vUv).rgb;
  vec3 bloomNarrow = texture(uBloomNarrow, vUv).rgb;
  // Halo = ring left over after subtracting the narrow (core) bloom from the
  // wide one — a difference-of-gaussians ring around real bright spots.
  vec3 halo = max(bloomWide - bloomNarrow, 0.0);

  vec3 color = base;
  color += bloomWide * uGlareIntensity * uGlareTint;
  color += halo * uHaloIntensity * uHaloTint * 2.0;

  color = applyContrastAndFog(color);
  color = applyYellowing(color);
  color = clamp(color, 0.0, 1.0);

  vec3 rawColor = texture(uRaw, vUv).rgb;

  vec3 finalColor = color;
  if (uViewMode == 1) {
    // Before/after slider: raw on the left of the divider, processed on the right.
    finalColor = vUv.x < uSplitPos ? rawColor : color;
  } else if (uViewMode == 2) {
    // Split screen: raw on left half, processed on right half, each squeezed
    // to fit its half of the canvas.
    if (vUv.x < 0.5) {
      vec2 uv2 = vec2(vUv.x * 2.0, vUv.y);
      finalColor = texture(uRaw, uv2).rgb;
    } else {
      vec2 uv2 = vec2((vUv.x - 0.5) * 2.0, vUv.y);
      finalColor = applyYellowing(applyContrastAndFog(
        texture(uBase, uv2).rgb
        + texture(uBloomWide, uv2).rgb * uGlareIntensity * uGlareTint
        + max(texture(uBloomWide, uv2).rgb - texture(uBloomNarrow, uv2).rgb, 0.0) * uHaloIntensity * uHaloTint * 2.0
      ));
      finalColor = clamp(finalColor, 0.0, 1.0);
    }
  }

  fragColor = vec4(finalColor, 1.0);
}
`;

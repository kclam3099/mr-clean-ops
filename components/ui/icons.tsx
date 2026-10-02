/**
 * The icon set.
 *
 * Inline SVG rather than an icon package: this app needs eight glyphs, and a
 * dependency that ships a thousand costs more in bundle than it saves in
 * typing. Every one is `currentColor` so it inherits whatever it sits in, and
 * `aria-hidden` because each is beside a word that already says what it means.
 *
 * WhatsApp is the exception and is drawn in its own green. A WhatsApp button
 * that looks like every other button gets read as "send a message somehow";
 * the glyph and the colour are how someone knows which app is about to open,
 * before they tap. The mark identifies the destination service, which is what
 * it is for.
 */

type IconProps = { className?: string };

const base = "shrink-0";

export function WhatsAppIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={`${base} ${className}`}>
      <path d="M17.47 14.38c-.3-.15-1.75-.86-2.02-.96-.27-.1-.47-.15-.67.15-.2.3-.77.96-.94 1.16-.17.2-.35.22-.64.07-.3-.15-1.25-.46-2.38-1.47-.88-.78-1.47-1.75-1.64-2.05-.17-.3-.02-.46.13-.6.13-.14.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.6-.92-2.2-.24-.58-.49-.5-.67-.51l-.57-.01c-.2 0-.52.07-.8.37-.27.3-1.04 1.02-1.04 2.48s1.07 2.88 1.22 3.08c.15.2 2.1 3.2 5.08 4.49.71.3 1.26.49 1.7.63.71.22 1.36.19 1.87.12.57-.09 1.75-.72 2-1.41.25-.69.25-1.28.17-1.41-.07-.13-.27-.2-.57-.35Z" />
      <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.46 1.32 4.96L2 22l5.25-1.38a9.86 9.86 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91C21.96 6.45 17.5 2 12.04 2Zm0 18.15h-.01c-1.48 0-2.93-.4-4.2-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.2 8.2 0 0 1-1.26-4.38c0-4.54 3.7-8.23 8.25-8.23 2.2 0 4.27.86 5.83 2.42a8.18 8.18 0 0 1 2.41 5.82c0 4.54-3.7 8.23-8.23 8.23Z" />
    </svg>
  );
}

export function PhoneIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden className={`${base} ${className}`}>
      <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h1.15a1.5 1.5 0 0 1 1.46 1.16l.57 2.42a1.5 1.5 0 0 1-.82 1.7l-.86.43a11.3 11.3 0 0 0 4.7 4.7l.43-.86a1.5 1.5 0 0 1 1.7-.82l2.42.57A1.5 1.5 0 0 1 18 12.35v1.15a1.5 1.5 0 0 1-1.5 1.5h-.5C8.49 15 2 8.51 2 4.5v-1Z" />
    </svg>
  );
}

export function MapPinIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden className={`${base} ${className}`}>
      <path
        fillRule="evenodd"
        d="M10 1.5a6 6 0 0 0-6 6c0 4.02 5.07 10.2 5.29 10.46a.93.93 0 0 0 1.42 0C10.93 17.7 16 11.52 16 7.5a6 6 0 0 0-6-6Zm0 8.25a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function ClockIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden className={`${base} ${className}`}>
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm.75-12.25a.75.75 0 0 0-1.5 0V10c0 .28.16.54.41.67l2.75 1.5a.75.75 0 1 0 .72-1.32l-2.38-1.3V5.75Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function MoneyIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden className={`${base} ${className}`}>
      <path
        fillRule="evenodd"
        d="M1.5 5.5A1.5 1.5 0 0 1 3 4h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 17 16H3a1.5 1.5 0 0 1-1.5-1.5v-9ZM10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM4.5 7a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm13 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function StarIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden className={`${base} ${className}`}>
      <path d="M10 1.5l2.47 5.2 5.53.74-4.05 3.95 1 5.61L10 14.4 5.05 17l1-5.61L2 7.44l5.53-.74L10 1.5Z" />
    </svg>
  );
}

export function CheckIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden className={`${base} ${className}`}>
      <path
        fillRule="evenodd"
        d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0l-3.5-3.5a1 1 0 1 1 1.4-1.4l2.8 2.79 6.8-6.79a1 1 0 0 1 1.4 0Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function BanIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden className={`${base} ${className}`}>
      <path
        fillRule="evenodd"
        d="M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16ZM4 10a6 6 0 0 1 9.75-4.66L5.34 13.75A5.97 5.97 0 0 1 4 10Zm6 6a5.97 5.97 0 0 1-3.75-1.34l8.41-8.41A6 6 0 0 1 10 16Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function ChevronRightIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden className={`${base} ${className}`}>
      <path
        fillRule="evenodd"
        d="M7.3 5.3a1 1 0 0 1 1.4 0l4 4a1 1 0 0 1 0 1.4l-4 4a1 1 0 1 1-1.4-1.4L10.58 10 7.3 6.7a1 1 0 0 1 0-1.4Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

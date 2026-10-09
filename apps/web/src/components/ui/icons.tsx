import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { title?: string };

/** Small stroke icons. Decorative by default (aria-hidden); pass a title to make one meaningful. */
function Icon({ title, children, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" role={title ? "img" : undefined} aria-hidden={title ? undefined : true}
      focusable="false" {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export const CheckIcon = (p: IconProps) => <Icon {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></Icon>;
export const CrossIcon = (p: IconProps) => <Icon {...p}><path d="M6 6l12 12M18 6L6 18" /></Icon>;
export const AlertIcon = (p: IconProps) => <Icon {...p}><path d="M12 4l9 16H3L12 4z" /><path d="M12 10v4M12 17.5v.01" /></Icon>;
export const ClockIcon = (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Icon>;
export const CopyIcon = (p: IconProps) => <Icon {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 012-2h9" /></Icon>;
export const ArrowRightIcon = (p: IconProps) => <Icon {...p}><path d="M5 12h14M13 6l6 6-6 6" /></Icon>;
export const RefreshIcon = (p: IconProps) => <Icon {...p}><path d="M20 11a8 8 0 10-2.3 5.7" /><path d="M20 5v6h-6" /></Icon>;
export const ShieldIcon = (p: IconProps) => <Icon {...p}><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" /></Icon>;
export const DotIcon = (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="4" fill="currentColor" /></Icon>;
export const MinusIcon = (p: IconProps) => <Icon {...p}><path d="M6 12h12" /></Icon>;

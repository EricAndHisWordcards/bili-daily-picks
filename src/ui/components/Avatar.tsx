/** 头像：远程图片离线失败时回退成渐变字母块。 */
import { useState } from 'react';
import { toHttpsUrl } from '../lib/view';

interface AvatarProps {
  src?: string | null;
  name?: string | null;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'hero';
  className?: string;
}

export function Avatar({ src, name, size = 'sm', className }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const url = toHttpsUrl(src);
  const initial = (name?.trim()?.[0] ?? '哔').toUpperCase();

  return (
    <span className={`avatar avatar--${size} ${className ?? ''}`} aria-hidden="true">
      {url && !failed ? (
        <img src={url} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
      ) : (
        <span className="avatar-initial">{initial}</span>
      )}
    </span>
  );
}

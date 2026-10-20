/** 视频卡片：封面 / 标题 / UP / 数据 / 来源 / 增长 / 推荐理由 / 不感兴趣。 */
import { useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import type { Recommendation } from '../../shared/types';
import { formatCount } from '../../shared/format';
import { relativeTime, formatDuration } from '../../shared/time';
import {
  formatEnglishNumber,
  openVideo,
  primarySource,
  sourceChipText,
  toCoverUrl,
  toVideoUrl,
} from '../lib/view';
import { Avatar } from './Avatar';
import { GrowthBadge } from './States';
import { IconClose, IconComment, IconPlay, IconSpark, IconStar, IconTv } from './Icons';

interface VideoCardProps {
  video: Recommendation;
  onDismiss: (bvid: string) => void;
}

export function VideoCard({ video, onDismiss }: VideoCardProps) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const cover = toCoverUrl(video.cover);
  const source = primarySource(video.sources);
  const open = () => openVideo(video.bvid);

  const handleClick = (event: MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('a, button')) return;
    open();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  };

  const handleDismiss = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onDismiss(video.bvid);
  };

  return (
    <article
      className="video-card"
      data-testid="video-card"
      data-bvid={video.bvid}
      data-region={video.parentRegion}
      role="link"
      tabIndex={0}
      aria-label={`打开视频：${video.title}`}
      title={video.title}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <div className="card-cover">
        {!cover || failed ? (
          <div className="cover-fallback">
            <IconTv size={30} strokeWidth={1.5} />
            <span>{cover ? '封面加载失败' : '暂无封面'}</span>
          </div>
        ) : (
          <img
            className={loaded ? 'is-loaded' : ''}
            src={cover}
            alt=""
            loading="lazy"
            decoding="async"
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
        )}
        <span className="cover-shade" aria-hidden="true" />
        <span className="duration-chip">{formatDuration(video.duration)}</span>
        {video.growth && <GrowthBadge growth={video.growth} />}
      </div>

      <div className="card-body">
        <div className="card-kicker">
          <span className={`source-chip source-chip--${source.kind}`}>{sourceChipText(source)}</span>
          {video.badges.slice(0, 2).map((badge) => (
            <span className="mini-chip" key={badge}>
              {badge}
            </span>
          ))}
        </div>

        <h3 className="card-title">
          <a
            href={toVideoUrl(video.bvid)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
          >
            {video.title}
          </a>
        </h3>

        <div className="card-owner">
          <Avatar src={video.owner.face} name={video.owner.name} size="xs" />
          <span className="owner-name" title={video.owner.name}>
            {video.owner.name}
          </span>
          <span className="region-chip">{video.tname || video.parentRegion}</span>
          <span className="pub-age">{relativeTime(video.pubdate * 1000)}</span>
        </div>

        <div className="card-stats">
          <span className="card-stat" title={`播放 ${formatEnglishNumber(video.stat.view)}`}>
            <IconPlay size={12} />
            {formatCount(video.stat.view)}
          </span>
          <span className="card-stat" title={`收藏 ${formatEnglishNumber(video.stat.favorite)}`}>
            <IconStar size={12} />
            {formatCount(video.stat.favorite)}
          </span>
          <span className="card-stat" title={`评论 ${formatEnglishNumber(video.stat.reply)}`}>
            <IconComment size={12} />
            {formatCount(video.stat.reply)}
          </span>
        </div>

        <p className="card-reason" title={video.reason}>
          {video.reason}
        </p>

        <div className="card-footer">
          <span className="match-chip" title="综合推荐分（兴趣 / 质量 / 增长 / 榜单 / 新鲜度）">
            <IconSpark size={11} />
            匹配 {Math.round(video.score * 100)}%
          </span>
          <button
            type="button"
            className="card-dismiss"
            aria-label={`不感兴趣：${video.title}`}
            onClick={handleDismiss}
          >
            <IconClose size={12} />
            不感兴趣
          </button>
        </div>
      </div>
    </article>
  );
}

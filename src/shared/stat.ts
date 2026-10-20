import { EMPTY_STAT } from './constants';
import type { VideoStat } from './types';

/** 把接口里的可选统计字段补全成完整 VideoStat */
export function normalizeStat(raw: Partial<VideoStat> | null | undefined): VideoStat {
  const pick = (value: number | undefined): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  return {
    view: pick(raw?.view),
    like: pick(raw?.like),
    favorite: pick(raw?.favorite),
    coin: pick(raw?.coin),
    reply: pick(raw?.reply),
    danmaku: pick(raw?.danmaku),
    share: pick(raw?.share),
  };
}

export function emptyStat(): VideoStat {
  return { ...EMPTY_STAT };
}

export interface EngagementRates {
  favRate: number;
  coinRate: number;
  likeRate: number;
  replyRate: number;
}

/** 互动率，统一用播放做分母；播放为 0 时全部返回 0 */
export function engagementRates(stat: VideoStat): EngagementRates {
  const view = Math.max(1, stat.view);
  return {
    favRate: stat.favorite / view,
    coinRate: stat.coin / view,
    likeRate: stat.like / view,
    replyRate: stat.reply / view,
  };
}

export function sumStat(a: VideoStat, b: VideoStat): VideoStat {
  return {
    view: a.view + b.view,
    like: a.like + b.like,
    favorite: a.favorite + b.favorite,
    coin: a.coin + b.coin,
    reply: a.reply + b.reply,
    danmaku: a.danmaku + b.danmaku,
    share: a.share + b.share,
  };
}

export function diffStat(later: VideoStat, earlier: VideoStat): VideoStat {
  return {
    view: Math.max(0, later.view - earlier.view),
    like: Math.max(0, later.like - earlier.like),
    favorite: Math.max(0, later.favorite - earlier.favorite),
    coin: Math.max(0, later.coin - earlier.coin),
    reply: Math.max(0, later.reply - earlier.reply),
    danmaku: Math.max(0, later.danmaku - earlier.danmaku),
    share: Math.max(0, later.share - earlier.share),
  };
}

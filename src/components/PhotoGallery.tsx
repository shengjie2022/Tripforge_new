import { useEffect, useRef, useState } from 'react'
import { fetchCityPhotos } from '../api/images'
import type { PhotoItem } from '../data/types'

/**
 * 加载某座城市的实景图
 *
 * 数据源是 Wikimedia Commons：免费、无需 API Key、允许跨域直连，
 * 且几乎所有图片都是 CC-BY / CC-BY-SA / 公有领域 —— 所以必须署名，
 * PhotoItem 里带了 author 和 license，界面上要展示出来。
 *
 * 检索失败一律静默降级（返回空数组），绝不影响攻略主流程。
 */
export function useCityPhotos(
  cityName: string,
  enName: string,
  attractionNames: string[]
) {
  const key = `${cityName}|${enName}`
  const [result, setResult] = useState<{ key: string; photos: PhotoItem[] }>({
    key: '',
    photos: [],
  })

  // 景点名只用于检索首图，切换天数时不必重新拉取
  const namesRef = useRef(attractionNames)
  useEffect(() => {
    namesRef.current = attractionNames
  }, [attractionNames])

  useEffect(() => {
    let alive = true
    void fetchCityPhotos(cityName, enName, namesRef.current, { max: 6 })
      .then((list) => {
        if (alive) setResult({ key, photos: list })
      })
      .catch(() => {
        if (alive) setResult({ key, photos: [] })
      })
    return () => {
      alive = false
    }
  }, [key, cityName, enName])

  // 城市换了就重新算 loading，不在 effect 里同步 setState
  const loading = result.key !== key
  const photos = result.key === key ? result.photos : []

  return { photos, loading }
}

/** 实景图网格 */
export function PhotoGallery({
  photos,
  loading,
}: {
  photos: PhotoItem[]
  loading: boolean
}) {
  if (loading) {
    return (
      <div className="photo-skeleton">
        <span className="dot" />
        <span className="dot" />
        <span className="dot" />
        <span className="dot" />
      </div>
    )
  }

  // 一张都没搜到就整块隐藏，不给用户看"失败"
  if (!photos.length) return null

  return (
    <>
      <div className="photo-grid">
        {photos.map((p) => (
          <a
            className="photo-cell"
            key={p.url}
            href={p.pageUrl}
            target="_blank"
            rel="noreferrer noopener"
            title={`${p.title} · ${p.author} · ${p.license}`}
          >
            <img src={p.url} alt={p.title} loading="lazy" />
            <div className="photo-cap">
              <div className="pt">{p.title}</div>
              <div className="pa">
                {p.author} · {p.license}
              </div>
            </div>
          </a>
        ))}
      </div>
      <div className="photo-credit">
        实景图来自 Wikimedia Commons，版权归原作者所有；点击图片可查看原始文件与授权全文。
        图片按景点名检索得到，不代表就是该景点本身。
      </div>
    </>
  )
}

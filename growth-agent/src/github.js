export async function searchRepos(query, { token = process.env.GITHUB_TOKEN, base = process.env.GITHUB_API_BASE || 'https://api.github.com', fetchImpl = fetch } = {}) {
  const url = new URL('/search/repositories', base)
  url.searchParams.set('q', query)
  url.searchParams.set('sort', 'updated')
  url.searchParams.set('per_page', '30')
  const response = await fetchImpl(url, { headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } })
  if (!response.ok) throw new Error(`GitHub search failed (${response.status}); check rate limit/token`)
  return (await response.json()).items || []
}

export async function fetchReadme(repo, { token = process.env.GITHUB_TOKEN, base = process.env.GITHUB_API_BASE || 'https://api.github.com', fetchImpl = fetch } = {}) {
  const url = new URL(`/repos/${repo}/readme`, base)
  const response = await fetchImpl(url, { headers: { Accept: 'application/vnd.github.raw+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } })
  if (!response.ok) return ''
  return (await response.text()).slice(0, 12000)
}

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  readLock,
  getProjectLockPath,
  getAgentsDir,
  normalizeSlug,
} from '../utils/lockfile.js'
import { assertSafeSlug } from '../utils/installer.js'
import { UserError } from '../utils/errors.js'

const SKILLS_SYSTEM_HEADER = `Only use skills listed in <available_skills> below.
Do not invoke a skill that is already loaded in your context.`

async function parseNameAndDescription(slug, dir) {
  try {
    const files = await readdir(dir)
    const skillFile = files.find(
      (f) => f === 'SKILL.md' || f.toLowerCase() === 'skill.md',
    )
    if (!skillFile) return { name: slug, description: '' }
    const content = await readFile(join(dir, skillFile), 'utf-8')
    const fm = content.match(/^---\n([\s\S]*?)\n---/)
    if (!fm) return { name: slug, description: '' }
    const yaml = fm[1]
    const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim() || slug
    const description = yaml.match(/^description:\s*(.+)$/m)?.[1]?.trim() || ''
    return { name, description }
  } catch {
    return { name: slug, description: '' }
  }
}

async function dirExists(d) {
  try {
    await stat(d)
    return true
  } catch {
    return false
  }
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

async function generateXml(allSkills) {
  const entries = Object.entries(allSkills)
  if (entries.length === 0) return ''

  const skillsXml = await Promise.all(
    entries.map(async ([lockSlug, entry]) => {
      const slug = entry.slug || lockSlug
      const normSlug = normalizeSlug(slug)
      const searchDirs = [
        { baseDir: getAgentsDir(), dir: join(getAgentsDir(), normSlug) },
        {
          baseDir: join(process.cwd(), '.agents', 'skills'),
          dir: join(process.cwd(), '.agents', 'skills', normSlug),
        },
      ]

      let existingDir = null
      for (const { baseDir, dir } of searchDirs) {
        try {
          assertSafeSlug(slug, baseDir, join(baseDir, slug))
          assertSafeSlug(slug, baseDir, dir)
        } catch (err) {
          if (err instanceof UserError && err.userCode === 'UNSAFE_SLUG') {
            return null
          }
          throw err
        }
        if (await dirExists(dir)) {
          existingDir = dir
          break
        }
      }

      const { name, description } = existingDir
        ? await parseNameAndDescription(entry.slug, existingDir)
        : { name: entry.slug, description: '' }

      const agentList = entry.agents || []
      const location = agentList.includes('project') ? 'project' : 'global'

      return `  <skill>
    <name>${escapeXml(name)}</name>
    <description>${escapeXml(description)}</description>
    <location>${location}</location>
  </skill>`
    }),
  )

  const included = skillsXml.filter(Boolean)
  if (included.length === 0) return ''

  return `<skills_system>
${SKILLS_SYSTEM_HEADER}

<available_skills>
${included.join('\n')}
</available_skills>
</skills_system>\n`
}

export async function agentsXmlApi(writeToFile = false) {
  const globalLock = await readLock()
  const projectLock = await readLock(getProjectLockPath(process.cwd())).catch(
    () => ({ skills: {} }),
  )
  const allSkills = { ...globalLock.skills }

  for (const [slug, entry] of Object.entries(projectLock.skills)) {
    if (!allSkills[slug]) allSkills[slug] = entry
  }

  const xml = await generateXml(allSkills)

  if (!xml) {
    return { xml: '', written: false }
  }

  if (writeToFile) {
    const agentsMdPath = join(process.cwd(), 'AGENTS.md')
    let existing = ''
    try {
      existing = await readFile(agentsMdPath, 'utf-8')
    } catch {}

    const sectionStart = existing.indexOf('<skills_system>')
    const sectionEnd = existing.indexOf('</skills_system>')

    if (sectionStart !== -1 && sectionEnd !== -1) {
      existing =
        existing.slice(0, sectionStart) +
        existing.slice(sectionEnd + '</skills_system>'.length)
    }

    const { writeFile } = await import('node:fs/promises')
    await writeFile(agentsMdPath, `${existing.trimEnd()}\n\n${xml}`.trimStart())
    return { xml, written: true, path: agentsMdPath }
  }

  return { xml, written: false }
}

import { useEffect, useRef, useState } from 'react'
import {
  LayoutDashboard,
  Users,
  Megaphone,
  Activity,
  Settings,
  Upload,
  Play,
  Plus,
  CircleCheck,
  Globe,
  Mail,
  MoreVertical,
  Square,
  Paperclip,
  Eye,
  Save,
  X,
  Code,
  Pencil,
  Trash2,
  CalendarDays,
  Clock3,
  Keyboard,
} from 'lucide-react'
import html2canvas from 'html2canvas'
import { jsPDF } from 'jspdf'
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
} from 'docx'
import PptxGenJS from 'pptxgenjs'
import './App.css'

const ATTACHMENT_FORMATS = [
  { value: 'PDF', label: 'PDF', extension: 'pdf' },
  { value: 'WKPDF', label: 'WKPDF', extension: 'pdf' },
  { value: 'PDF_ENCODE', label: 'PDF ENCODE', extension: 'pdf' },
  { value: 'PDF_IMAGE', label: 'PDF IMAGE', extension: 'pdf' },
  { value: 'PDF_IMAGE_PNG', label: 'PDF IMAGE PNG', extension: 'pdf' },
  { value: 'PNG', label: 'IMAGE PNG', extension: 'png' },
  { value: 'JPG', label: 'IMAGE JPG', extension: 'jpg' },
  { value: 'HEIC', label: 'IMAGE HEIC', extension: 'heic' },
  { value: 'TXT', label: 'TXT', extension: 'txt' },
  { value: 'DOCX', label: 'DOCX', extension: 'docx' },
  { value: 'XLSX', label: 'XLSX', extension: 'xlsx' },
  { value: 'PPTX', label: 'PPTX', extension: 'pptx' },
  { value: 'HTML', label: 'HTML', extension: 'html' },
]

const PREVIEW_ATTACHMENT_TAGS = {
  id: 'A7K2M9QX',
  name: 'Emily Carter',
  email: 'recipient@example.com',
}

function resolvePreviewAttachmentTags(value, customVariables = {}) {
  const previewTags = {
    ...PREVIEW_ATTACHMENT_TAGS,
    tfn: String(customVariables.tfn ?? ''),
  }

  return String(value || '').replace(/\{\{([^}]+)\}\}/g, (match, key) => {
    const normalizedKey = String(key).trim().toLowerCase()
    return Object.prototype.hasOwnProperty.call(previewTags, normalizedKey)
      ? previewTags[normalizedKey]
      : match
  })
}

function stripHtml(html) {
  const documentFragment = new DOMParser().parseFromString(
    String(html || ''),
    'text/html'
  )
  return documentFragment.body.textContent?.trim() || ''
}

function attachmentBaseName(value) {
  return (
    String(value || 'attachment')
      .trim()
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .trim() || 'attachment'
  )
}

function createHtmlRenderNode(html) {
  const node = document.createElement('div')
  node.innerHTML = html
  node.style.position = 'fixed'
  node.style.left = '-100000px'
  node.style.top = '0'
  node.style.width = '794px'
  node.style.padding = '36px'
  node.style.background = '#ffffff'
  node.style.color = '#111111'
  node.style.fontFamily = 'Arial, sans-serif'
  node.style.fontSize = '16px'
  node.style.lineHeight = '1.5'
  node.style.boxSizing = 'border-box'
  document.body.appendChild(node)
  return node
}

async function renderHtmlCanvas(html) {
  const node = createHtmlRenderNode(html)
  try {
    return await html2canvas(node, {
      backgroundColor: '#ffffff',
      scale: 2,
      useCORS: true,
      logging: false,
    })
  } finally {
    node.remove()
  }
}

function blobToFile(blob, fileName) {
  return new File([blob], fileName, {
    type: blob.type || 'application/octet-stream',
  })
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''

  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }

  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`
}

async function renderHtmlWithElectron(html, type, options = {}) {
  if (!window.electronAPI?.renderHtmlAsset) return null

  const result = await window.electronAPI.renderHtmlAsset({
    html,
    type,
    ...options,
  })

  if (!result?.success) {
    throw new Error(
      result?.error || 'Could not render the HTML attachment in Chromium.'
    )
  }

  return {
    blob: new Blob([result.data], {
      type: result.mimeType || 'application/octet-stream',
    }),
    width: result.width,
    height: result.height,
    displayWidth: result.displayWidth,
    displayHeight: result.displayHeight,
  }
}

async function createPdfFromHtml(html, imageOnly = false) {
  const chromiumPdf = await renderHtmlWithElectron(html, 'pdf')
  if (chromiumPdf) return chromiumPdf.blob

  const pdf = new jsPDF({
    unit: 'pt',
    format: 'a4',
    compress: true,
  })

  if (imageOnly) {
    const canvas = await renderHtmlCanvas(html)
    const pageWidth = pdf.internal.pageSize.getWidth()
    const pageHeight = pdf.internal.pageSize.getHeight()
    const imageHeight = (canvas.height * pageWidth) / canvas.width
    let remainingHeight = imageHeight
    let offset = 0

    while (remainingHeight > 0) {
      if (offset > 0) pdf.addPage()
      pdf.addImage(
        canvas.toDataURL('image/png'),
        'PNG',
        0,
        -offset,
        pageWidth,
        imageHeight
      )
      offset += pageHeight
      remainingHeight -= pageHeight
    }
  } else {
    const node = createHtmlRenderNode(html)
    try {
      await new Promise((resolve, reject) => {
        pdf.html(node, {
          margin: 36,
          autoPaging: 'text',
          html2canvas: {
            scale: 1,
            useCORS: true,
          },
          callback: () => resolve(),
          onerror: reject,
        })
      })
    } finally {
      node.remove()
    }
  }

  return pdf.output('blob')
}

async function createAttachmentFromHtml(html, format, requestedName) {
  const option = ATTACHMENT_FORMATS.find((item) => item.value === format)
  const baseName = attachmentBaseName(
    resolvePreviewAttachmentTags(requestedName || '{{id}}')
  )
  const extension = option?.extension || 'html'
  const fileName = `${baseName}.${extension}`
  const plainText = stripHtml(html)

  if (format === 'HTML') {
    return blobToFile(new Blob([html], { type: 'text/html' }), fileName)
  }

  if (format === 'TXT') {
    return blobToFile(new Blob([plainText], { type: 'text/plain' }), fileName)
  }

  if (format === 'PDF' || format === 'WKPDF' || format === 'PDF_ENCODE') {
    return blobToFile(await createPdfFromHtml(html), fileName)
  }

  if (format === 'PDF_IMAGE' || format === 'PDF_IMAGE_PNG') {
    return blobToFile(await createPdfFromHtml(html, true), fileName)
  }

  if (format === 'PNG' || format === 'JPG') {
    const imageType = format === 'PNG' ? 'image/png' : 'image/jpeg'
    const renderedImage = await renderHtmlWithElectron(
      html,
      format === 'PNG' ? 'png' : 'jpeg'
    )
    let imageBlob = renderedImage?.blob

    if (!imageBlob) {
      const canvas = await renderHtmlCanvas(html)
      imageBlob = await new Promise((resolve) =>
        canvas.toBlob(resolve, imageType, format === 'JPG' ? 0.92 : undefined)
      )
    }

    if (!imageBlob) throw new Error('Could not render the HTML as an image.')
    return blobToFile(imageBlob, fileName)
  }

  if (format === 'HEIC') {
    const renderedPng = await renderHtmlWithElectron(html, 'png')
    let pngBlob = renderedPng?.blob

    if (!pngBlob) {
      const canvas = await renderHtmlCanvas(html)
      pngBlob = await new Promise((resolve) =>
        canvas.toBlob(resolve, 'image/png')
      )
    }

    const pngBytes = await pngBlob.arrayBuffer()
    const converted = await window.electronAPI?.convertPngToHeic?.({
      name: fileName,
      data: pngBytes,
    })
    if (!converted?.success) {
      throw new Error(
        converted?.error ||
          'HEIC conversion is available in the macOS Electron app only.'
      )
    }
    return new File([converted.data], fileName, { type: 'image/heic' })
  }

  if (format === 'DOCX') {
    const paragraphs = plainText
      .split(/\n+/)
      .filter(Boolean)
      .map(
        (line, index) =>
          new Paragraph({
            text: line,
            heading: index === 0 ? HeadingLevel.HEADING_1 : undefined,
          })
      )
    const document = new Document({
      sections: [{ children: paragraphs.length ? paragraphs : [new Paragraph('')] }],
    })
    return blobToFile(await Packer.toBlob(document), fileName)
  }

  if (format === 'XLSX') {
    const renderedImage = await renderHtmlWithElectron(html, 'png', {
      trimToContent: true,
    })
    if (!renderedImage) {
      throw new Error(
        'XLSX image attachments must be generated from the Electron app.'
      )
    }

    const converted = await window.electronAPI?.createXlsxFromImage?.({
      name: fileName,
      data: await renderedImage.blob.arrayBuffer(),
      width: renderedImage.displayWidth || renderedImage.width,
      height: renderedImage.displayHeight || renderedImage.height,
    })

    if (!converted?.success) {
      throw new Error(
        converted?.error || 'Could not create the XLSX image attachment.'
      )
    }

    return new File([converted.data], fileName, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
  }

  if (format === 'PPTX') {
    const renderedImage = await renderHtmlWithElectron(html, 'png', {
      trimToContent: true,
    })
    if (!renderedImage) {
      throw new Error(
        'PPTX image attachments must be generated from the Electron app.'
      )
    }

    const imageWidth = Math.max(
      Number(renderedImage.displayWidth || renderedImage.width) || 1200,
      1
    )
    const imageHeight = Math.max(
      Number(renderedImage.displayHeight || renderedImage.height) || 900,
      1
    )
    const naturalWidth = imageWidth / 96
    const naturalHeight = imageHeight / 96
    const scale = Math.min(
      13.333 / naturalWidth,
      20 / naturalHeight
    )
    const slideWidth = naturalWidth * scale
    const slideHeight = naturalHeight * scale
    const presentation = new PptxGenJS()
    presentation.defineLayout({
      name: 'HTML_CONTENT',
      width: slideWidth,
      height: slideHeight,
    })
    presentation.layout = 'HTML_CONTENT'
    const slide = presentation.addSlide()
    slide.background = { color: 'FFFFFF' }
    slide.addImage({
      data: await blobToDataUrl(renderedImage.blob),
      x: 0,
      y: 0,
      w: slideWidth,
      h: slideHeight,
    })
    const data = await presentation.write({ outputType: 'blob' })
    return new File([data], fileName, {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    })
  }

  throw new Error(`Unsupported attachment format: ${format}`)
}

function parseCsvLine(line) {
  const values = []
  let value = ''
  let quoted = false

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    const nextCharacter = line[index + 1]

    if (character === '"' && quoted && nextCharacter === '"') {
      value += '"'
      index += 1
    } else if (character === '"') {
      quoted = !quoted
    } else if (character === ',' && !quoted) {
      values.push(value.trim())
      value = ''
    } else {
      value += character
    }
  }

  values.push(value.trim())
  return values
}

function parseCsvText(text) {
  const rows = []
  let row = []
  let value = ''
  let quoted = false

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    const nextCharacter = text[index + 1]

    if (character === '"' && quoted && nextCharacter === '"') {
      value += '"'
      index += 1
    } else if (character === '"') {
      quoted = !quoted
    } else if (character === ',' && !quoted) {
      row.push(value.trim())
      value = ''
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && nextCharacter === '\n') index += 1
      row.push(value.trim())
      if (row.some((cell) => cell.length > 0)) rows.push(row)
      row = []
      value = ''
    } else {
      value += character
    }
  }

  row.push(value.trim())
  if (row.some((cell) => cell.length > 0)) rows.push(row)

  if (!rows.length) return { headers: [], data: [] }

  const headers = rows[0].map((header) =>
    header.replace(/^["']|["']$/g, '').trim()
  )
  const data = rows.slice(1).map((cells) =>
    Object.fromEntries(
      headers.map((header, index) => [header, cells[index] || ''])
    )
  )

  return { headers, data }
}

function looksLikeHtml(value) {
  return /<\s*\/?\s*[a-z][^>]*>/i.test(String(value || ''))
}

function getProfileCampaigns(campaigns, profileId) {
  return campaigns.filter((campaign) => {
    const assignedProfileIds = campaign.profileIds?.length
      ? campaign.profileIds
      : campaign.profileId
        ? [campaign.profileId]
        : []

    return assignedProfileIds.includes(profileId)
  })
}

function ProfileStats({ campaigns, profileId }) {
  const assignedCampaigns = getProfileCampaigns(campaigns, profileId)
  const sent = assignedCampaigns.reduce(
    (total, campaign) => total + (campaign.sent || 0),
    0
  )
  const failed = assignedCampaigns.reduce(
    (total, campaign) => total + (campaign.failed || 0),
    0
  )
  const pending = assignedCampaigns.reduce(
    (total, campaign) =>
      total +
      Math.max((campaign.recipients || 0) - (campaign.sent || 0) - (campaign.failed || 0), 0),
    0
  )

  return (
    <div className="profile-stats" aria-label="Profile campaign statistics">
      <div>
        <span>Campaigns</span>
        <strong>{assignedCampaigns.length}</strong>
      </div>
      <div>
        <span>Sent</span>
        <strong>{sent}</strong>
      </div>
      <div>
        <span>Pending</span>
        <strong>{pending}</strong>
      </div>
      <div>
        <span>Failed</span>
        <strong>{failed}</strong>
      </div>
    </div>
  )
}

function App() {
  const [active, setActive] = useState('Dashboard')

  const [profiles, setProfiles] = useState([
    {
      id: 1,
      name: 'Chrome Profile 1',
      status: 'offline',
      lastActive: 'Never',
      running: false,
      debugPort: 9222,
    },
  ])
  const [senderRows, setSenderRows] = useState([])
  const senderRowsRef = useRef([])

  const [showAdd, setShowAdd] = useState(false)
  const [profileName, setProfileName] = useState('')
  const [editingProfileId, setEditingProfileId] = useState(null)
  const [openProfileMenuId, setOpenProfileMenuId] = useState(null)

  const [campaigns, setCampaigns] = useState([])
  const [showCreateCampaign, setShowCreateCampaign] = useState(false)
  const [editingCampaignId, setEditingCampaignId] = useState(null)

  const [campaignName, setCampaignName] = useState('Mail Campaign')
  const [selectedProfileIds, setSelectedProfileIds] = useState(['1'])
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [htmlMode, setHtmlMode] = useState(false)
  const [csvFile, setCsvFile] = useState(null)
  const [attachment, setAttachment] = useState(null)
  const [attachmentMode, setAttachmentMode] = useState('html')
  const [attachmentHtml, setAttachmentHtml] = useState(
    '<h1>Hello {{name}}</h1><p>Your attached document is ready.</p>'
  )
  const [tfnValue, setTfnValue] = useState('')
  const [attachmentFormat, setAttachmentFormat] = useState('PDF')
  const [attachmentFileName, setAttachmentFileName] = useState('{{id}}')
  const [isGeneratingAttachment, setIsGeneratingAttachment] = useState(false)
  const [recipientCount, setRecipientCount] = useState(0)
  const [csvHeaders, setCsvHeaders] = useState([])
  const [csvRows, setCsvRows] = useState([])
  const [delaySeconds, setDelaySeconds] = useState(0)
  const [typingDelayMs, setTypingDelayMs] = useState(0)
  const activeCampaignRuns = useRef(new Set())
  const campaignsRef = useRef([])
  const [activityLog, setActivityLog] = useState([
    {
      id: 1,
      type: 'system',
      title: 'System ready',
      detail: 'Mail System is ready for automation.',
      time: 'Just now',
    },
  ])
  const [settings, setSettings] = useState({
    defaultDelay: 0,
    confirmBeforeSend: false,
  })
  const [settingsSaved, setSettingsSaved] = useState(false)

  const menu = [
    { name: 'Dashboard', icon: LayoutDashboard },
    { name: 'Profiles', icon: Users },
    { name: 'Campaigns', icon: Megaphone },
    { name: 'Activity Log', icon: Activity },
    { name: 'Settings', icon: Settings },
  ]

  const addActivity = (type, title, detail) => {
    setActivityLog((previous) => [
      {
        id: Date.now() + Math.random(),
        type,
        title,
        detail,
        time: new Date().toLocaleString(),
      },
      ...previous,
    ].slice(0, 100))
  }

  const addProfile = () => {
    const name = profileName.trim()
    if (!name) return

    if (editingProfileId !== null) {
      setProfiles((prev) =>
        prev.map((profile) =>
          profile.id === editingProfileId ? { ...profile, name } : profile
        )
      )
      setProfileName('')
      setEditingProfileId(null)
      setShowAdd(false)
      addActivity('profile', 'Profile renamed', `${name} is now the profile name.`)
      return
    }

    setProfiles((prev) => [
      ...prev,
      {
        id: Date.now(),
        name,
        status: 'offline',
        lastActive: 'Never',
        running: false,
        debugPort: 9222 + prev.length,
      },
    ])

    setProfileName('')
    setShowAdd(false)
    addActivity('profile', 'Profile added', `${name} is ready to be opened.`)
  }

  const openAddProfile = () => {
    setEditingProfileId(null)
    setProfileName('')
    setShowAdd(true)
  }

  const openRenameProfile = (profile) => {
    setEditingProfileId(profile.id)
    setProfileName(profile.name)
    setOpenProfileMenuId(null)
    setShowAdd(true)
  }

  const deleteProfile = (profile) => {
    const confirmed = window.confirm(
      `Delete "${profile.name}"? Assigned campaigns will be unassigned.`
    )

    if (!confirmed) return

    const remainingProfiles = profiles.filter((item) => item.id !== profile.id)

    setProfiles((prev) => prev.filter((item) => item.id !== profile.id))
    setSenderRows((prev) =>
      prev.filter((row) => row.profileId !== profile.id)
    )
    setSelectedProfileIds((prev) => {
      const nextSelectedIds = prev.filter(
        (profileId) => Number(profileId) !== profile.id
      )
      if (nextSelectedIds.length) return nextSelectedIds
      return remainingProfiles[0] ? [String(remainingProfiles[0].id)] : []
    })
    setCampaigns((prev) =>
      prev.map((campaign) => {
        const profileIds = (
          campaign.profileIds?.length
            ? campaign.profileIds
            : campaign.profileId
              ? [campaign.profileId]
              : []
        ).filter((id) => id !== profile.id)

        return {
          ...campaign,
          profileIds,
          profileId: profileIds[0] || null,
          profileName: profileIds
            .map((id) => profiles.find((item) => item.id === id)?.name)
            .filter(Boolean)
            .join(', ') || null,
        }
      })
    )
    setOpenProfileMenuId(null)
    addActivity('profile', 'Profile deleted', `${profile.name} was removed.`)
  }

  useEffect(() => {
    if (openProfileMenuId === null) return undefined

    const closeMenu = (event) => {
      if (!event.target.closest('.profile-menu-wrap')) {
        setOpenProfileMenuId(null)
      }
    }
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setOpenProfileMenuId(null)
    }

    document.addEventListener('mousedown', closeMenu)
    document.addEventListener('keydown', closeOnEscape)

    return () => {
      document.removeEventListener('mousedown', closeMenu)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [openProfileMenuId])

  const startCampaignsForProfile = (profileId) => {
    setCampaigns((prev) =>
      prev.map((campaign) => {
        const completed =
          (campaign.sent || 0) + (campaign.failed || 0) >= campaign.recipients
        const assignedProfileIds = campaign.profileIds?.length
          ? campaign.profileIds
          : campaign.profileId
            ? [campaign.profileId]
            : []

        return assignedProfileIds.includes(profileId) && !completed
          ? {
              ...campaign,
              status: 'Running',
              startedAt: campaign.startedAt || new Date().toLocaleString(),
            }
          : campaign
      })
    )
  }

  const pauseCampaignsForProfile = (profileId) => {
    setCampaigns((prev) =>
      prev.map((campaign) => {
        const assignedProfileIds = campaign.profileIds?.length
          ? campaign.profileIds
          : campaign.profileId
            ? [campaign.profileId]
            : []
        const anotherProfileIsRunning = assignedProfileIds.some(
          (assignedId) =>
            assignedId !== profileId &&
            profiles.some(
              (profile) => profile.id === assignedId && profile.running
            )
        )

        return assignedProfileIds.includes(profileId) &&
          campaign.status === 'Running' &&
          !anotherProfileIsRunning
          ? { ...campaign, status: 'Paused' }
          : campaign
      })
    )
  }

  const runCampaignOnProfile = async (campaign, profile) => {
    if (activeCampaignRuns.current.has(campaign.id)) return

    if (!campaign.recipientRows?.length) {
      alert('This campaign has no CSV recipient rows. Upload the CSV again.')
      return
    }

    if (
      settings.confirmBeforeSend &&
      !window.confirm(`Start sending "${campaign.name}" now?`)
    ) {
      addActivity(
        'campaign',
        'Campaign start cancelled',
        `${campaign.name} was not started.`
      )
      return
    }

    const campaignComplete =
      campaign.recipients > 0 &&
      (campaign.sent || 0) + (campaign.failed || 0) >= campaign.recipients
    const startIndex = campaignComplete
      ? 0
      : Number(campaign.nextRecipientIndex ?? campaign.sent ?? 0)
    const baseSent = campaignComplete ? 0 : campaign.sent || 0
    const baseFailed = campaignComplete ? 0 : campaign.failed || 0
    const recipientRows = campaign.recipientRows.slice(startIndex)

    if (!recipientRows.length) {
      alert('There are no pending recipients in this campaign.')
      return
    }

    activeCampaignRuns.current.add(campaign.id)

    setCampaigns((prev) =>
      prev.map((item) =>
        item.id === campaign.id
          ? {
              ...item,
              status: 'Running',
              startedAt: item.startedAt || new Date().toLocaleString(),
            }
          : item
      )
    )

    if (!window.electronAPI?.runCampaign) {
      activeCampaignRuns.current.delete(campaign.id)
      return
    }

    let attachmentPayload = null

    try {
      if (campaign.attachment?.arrayBuffer) {
        attachmentPayload = {
          name: campaign.attachment.name,
          data: await campaign.attachment.arrayBuffer(),
        }
      }

      const attachmentUsesTemplate = Boolean(
        campaign.attachment &&
          campaign.attachmentHtml &&
          (campaign.attachmentMode === 'html' ||
            /\{\{[^}]+\}\}/.test(campaign.attachmentFileName || '') ||
            /\{\{[^}]+\}\}/.test(campaign.attachmentHtml || ''))
      )

      const result = await window.electronAPI.runCampaign({
        campaignId: campaign.id,
        profileId: profile.id,
        port: profile.debugPort || 9222,
        recipients: recipientRows,
        startIndex,
        baseSent,
        baseFailed,
        totalRecipients: campaign.recipients,
        subject: campaign.subject,
        body: campaign.body,
        htmlMode: Boolean(campaign.htmlMode || looksLikeHtml(campaign.body)),
        delaySeconds: campaign.delaySeconds ?? 0,
        typingDelayMs: campaign.typingDelayMs ?? 0,
        customVariables: campaign.customVariables || { tfn: '' },
        attachment: attachmentUsesTemplate ? null : attachmentPayload,
        attachmentTemplate:
          attachmentUsesTemplate
            ? {
                html: campaign.attachmentHtml,
                format: campaign.attachmentFormat || 'PDF',
                fileName: campaign.attachmentFileName || '{{id}}',
              }
            : null,
      })

      if (!result?.success) {
        setCampaigns((prev) =>
          prev.map((item) =>
            item.id === campaign.id
              ? { ...item, status: 'Failed', lastError: result?.error }
              : item
          )
        )
        alert(result?.error || 'Campaign could not be started.')
      }
    } catch (error) {
      setCampaigns((prev) =>
        prev.map((item) =>
          item.id === campaign.id
            ? { ...item, status: 'Failed', lastError: error.message }
            : item
        )
      )
      alert(error.message || 'Campaign could not be started.')
    } finally {
      activeCampaignRuns.current.delete(campaign.id)
    }
  }

  const runAssignedCampaignsForProfile = (profile, restartCompleted = false) => {
    campaigns
      .filter((campaign) => {
        const assignedProfileIds = campaign.profileIds?.length
          ? campaign.profileIds
          : campaign.profileId
            ? [campaign.profileId]
            : []

        return (
          assignedProfileIds.includes(profile.id) &&
          (restartCompleted || campaign.status !== 'Completed') &&
          !activeCampaignRuns.current.has(campaign.id)
        )
      })
      .forEach((campaign) => {
        void runCampaignOnProfile(campaign, profile)
      })
  }

  const startProfileAutomation = async (profile) => {
    let success = true

    if (window.electronAPI?.startProfile) {
      const result = await window.electronAPI.startProfile(
        profile.debugPort || 9222
      )
      success = result?.success !== false

      if (!success) {
        alert(result?.error || 'Unable to start automation.')
      }
    }

    if (success) {
      setProfiles((prev) =>
        prev.map((p) =>
          p.id === profile.id
            ? {
                ...p,
                running: true,
                status: 'running',
                lastActive: 'Just now',
              }
            : p
        )
      )
      startCampaignsForProfile(profile.id)
      addActivity('profile', 'Profile started', `${profile.name} is running.`)
    }

    return success
  }

  const toggleStart = async (profile) => {
    if (profile.running) {
      setProfiles((prev) =>
        prev.map((p) =>
          p.id === profile.id
            ? { ...p, running: false, status: 'online' }
            : p
        )
      )
      pauseCampaignsForProfile(profile.id)
      addActivity('profile', 'Profile stopped', `${profile.name} was stopped.`)
      campaigns
        .filter((campaign) => {
          const assignedProfileIds = campaign.profileIds?.length
            ? campaign.profileIds
            : campaign.profileId
              ? [campaign.profileId]
              : []
          return (
            assignedProfileIds.includes(profile.id) &&
            campaign.status === 'Running'
          )
        })
        .forEach((campaign) => {
          void window.electronAPI?.stopCampaign?.(campaign.id)
        })
      return
    }

    const success = await startProfileAutomation(profile)
    if (success) {
      runAssignedCampaignsForProfile(profile, true)
    }
  }

  useEffect(() => {
    campaignsRef.current = campaigns
  }, [campaigns])

  useEffect(() => {
    senderRowsRef.current = senderRows
  }, [senderRows])

  useEffect(() => {
    if (!senderRows.length || !window.electronAPI?.checkChromeProfile) {
      return undefined
    }

    let cancelled = false

    const checkRows = async () => {
      const results = await Promise.all(
        senderRowsRef.current.map(async (row) => {
          const profile = profiles.find((item) => item.id === row.profileId)
          if (!profile) return { rowId: row.id, ready: false }

          const result = await window.electronAPI.checkChromeProfile(
            profile.debugPort || 9222
          )

          return {
            rowId: row.id,
            ready: Boolean(result?.ready),
          }
        })
      )

      if (cancelled) return

      setSenderRows((previous) =>
        previous.map((row) => {
          const result = results.find((item) => item.rowId === row.id)
          if (!result) return row

          const profile = profiles.find((item) => item.id === row.profileId)
          const ready = result.ready

          return {
            ...row,
            status: ready ? 'ready' : 'waiting',
            profileName: ready
              ? profile?.name || `Chrome Profile ${row.profileId}`
              : 'Waiting for Gmail account',
          }
        })
      )
    }

    void checkRows()
    const intervalId = window.setInterval(checkRows, 2000)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [profiles, senderRows.length])

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onCampaignProgress?.((progress) => {
      const updatedCampaigns = campaignsRef.current.map((campaign) =>
        campaign.id === progress.campaignId
          ? {
              ...campaign,
              status: progress.status || campaign.status,
              sent: progress.sent ?? campaign.sent ?? 0,
              failed: progress.failed ?? campaign.failed ?? 0,
              pending:
                progress.pending ??
                Math.max(
                  (campaign.recipients || 0) -
                    (progress.sent ?? campaign.sent ?? 0) -
                    (progress.failed ?? campaign.failed ?? 0),
                  0
                ),
              nextRecipientIndex:
                progress.nextRecipientIndex ??
                campaign.nextRecipientIndex ??
                0,
              lastRecipient: progress.recipientEmail || campaign.lastRecipient,
              lastError: progress.error || campaign.lastError,
            }
          : campaign
      )

      campaignsRef.current = updatedCampaigns
      setCampaigns(updatedCampaigns)

      if (progress.recipientEmail) {
        addActivity(
          progress.error ? 'error' : 'send',
          progress.error ? 'Email failed' : 'Email sent',
          `${progress.recipientEmail}${
            progress.error ? ` — ${progress.error}` : ''
          }`
        )
      }

      if (['Completed', 'Failed', 'Paused'].includes(progress.status)) {
        addActivity(
          progress.status === 'Completed'
            ? 'success'
            : progress.status === 'Paused'
              ? 'profile'
              : 'error',
          `Campaign ${progress.status.toLowerCase()}`,
          `Campaign #${progress.campaignId} finished with ${
            progress.sent || 0
          } sent and ${progress.failed || 0} failed.`
        )
      }

      if (
        ['Completed', 'Failed'].includes(progress.status) &&
        progress.profileId !== undefined
      ) {
        const profileId = Number(progress.profileId)
        const anotherCampaignIsRunning = updatedCampaigns.some((campaign) => {
          const assignedProfileIds = campaign.profileIds?.length
            ? campaign.profileIds
            : campaign.profileId
              ? [campaign.profileId]
              : []

          return (
            assignedProfileIds.includes(profileId) &&
            campaign.status === 'Running'
          )
        })

        if (!anotherCampaignIsRunning) {
          setProfiles((prev) =>
            prev.map((profile) =>
              profile.id === profileId
                ? { ...profile, running: false, status: 'online' }
                : profile
            )
          )
        }
      }
    })

    return () => unsubscribe?.()
  }, [])

  const openProfile = async (profile) => {
    setProfiles((prev) =>
      prev.map((p) =>
        p.id === profile.id
          ? {
              ...p,
              status: 'online',
              lastActive: 'Just now',
            }
          : p
      )
    )

    if (window.electronAPI?.openChromeProfile) {
      const result = await window.electronAPI.openChromeProfile(
        profile.id,
        profile.debugPort || 9222
      )

      if (!result.success) {
        alert(result.error)
      }
    }

    addActivity('profile', 'Profile opened', `${profile.name} was opened.`)
  }

  const handleNewSenderRow = () => {
    const nextProfileId =
      profiles.reduce((highest, profile) => Math.max(highest, profile.id), 0) + 1
    const nextRowNumber = senderRows.length + 2
    const newProfile = {
      id: nextProfileId,
      name: `Chrome Profile ${nextProfileId}`,
      status: 'offline',
      lastActive: 'Never',
      running: false,
      debugPort: 9222 + profiles.length,
    }

    setProfiles((previous) => [...previous, newProfile])
    setSenderRows((previous) => [
      ...previous,
      {
        id: `${nextRowNumber}-${nextProfileId}`,
        rowNumber: nextRowNumber,
        profileId: nextProfileId,
        profileName: 'Waiting for Gmail account',
        status: 'waiting',
        subject: '',
        body: '',
        csvFile: null,
        csvHeaders: [],
        csvRows: [],
        recipientCount: 0,
        campaignId: null,
      },
    ])
    void openProfile(newProfile)
    addActivity(
      'profile',
      'New sender row added',
      `${newProfile.name} was opened for Gmail login.`
    )
  }

  const setSenderRowField = (rowId, field, value) => {
    setSenderRows((previous) =>
      previous.map((row) =>
        row.id === rowId ? { ...row, [field]: value } : row
      )
    )
  }

  const generateAttachment = async () => {
    if (!attachmentHtml.trim()) {
      alert('Enter HTML content before generating an attachment.')
      return
    }

    setIsGeneratingAttachment(true)

    try {
      const generatedFile = await createAttachmentFromHtml(
        resolvePreviewAttachmentTags(attachmentHtml, { tfn: tfnValue }),
        attachmentFormat,
        resolvePreviewAttachmentTags(attachmentFileName, { tfn: tfnValue })
      )
      setAttachment(generatedFile)
      setAttachmentMode('html')
      addActivity(
        'campaign',
        'Attachment generated',
        `${generatedFile.name} was created from HTML.`
      )
    } catch (error) {
      alert(error.message || 'Could not generate this attachment.')
    } finally {
      setIsGeneratingAttachment(false)
    }
  }

  const resetCampaignForm = () => {
    setCampaignName('Mail Campaign')
    setSelectedProfileIds(profiles[0] ? [String(profiles[0].id)] : [])
    setSubject('')
    setBody('')
    setHtmlMode(false)
    setCsvFile(null)
    setAttachment(null)
    setRecipientCount(0)
    setCsvHeaders([])
    setCsvRows([])
    setDelaySeconds(settings.defaultDelay ?? 0)
    setTypingDelayMs(0)
    setAttachment(null)
    setAttachmentMode('html')
    setAttachmentHtml(
      '<h1>Hello {{name}}</h1><p>Your attached document is ready.</p>'
    )
    setTfnValue('')
    setAttachmentFormat('PDF')
    setAttachmentFileName('{{id}}')
  }

  const openCampaignCreator = () => {
    resetCampaignForm()
    setEditingCampaignId(null)
    setShowCreateCampaign(true)
  }

  const openCampaignEditor = (campaign) => {
    setCampaignName(campaign.name)
    setSelectedProfileIds(
      campaign.profileIds?.length
        ? campaign.profileIds.map(String)
        : campaign.profileId
          ? [String(campaign.profileId)]
          : []
    )
    setSubject(campaign.subject)
    setBody(campaign.body)
    setHtmlMode(campaign.htmlMode)
    setCsvFile(
      campaign.csvFile ||
        (campaign.csvName
          ? { name: campaign.csvName, size: 0, type: 'text/csv' }
          : null)
    )
    setAttachment(
      campaign.attachment ||
        (campaign.attachmentName
          ? { name: campaign.attachmentName, size: 0 }
          : null)
    )
    setAttachmentMode(campaign.attachmentMode || 'upload')
    setAttachmentHtml(
      campaign.attachmentHtml ||
        '<h1>Hello {{name}}</h1><p>Your attached document is ready.</p>'
    )
    setTfnValue(campaign.customVariables?.tfn || '')
    setAttachmentFormat(campaign.attachmentFormat || 'PDF')
    setAttachmentFileName(campaign.attachmentFileName || '{{id}}')
    setRecipientCount(campaign.recipients)
    setCsvHeaders(campaign.csvHeaders || [])
    setCsvRows(campaign.recipientRows || [])
    setDelaySeconds(campaign.delaySeconds ?? 0)
    setTypingDelayMs(campaign.typingDelayMs ?? 0)
    setEditingCampaignId(campaign.id)
    setActive('Campaigns')
    setShowCreateCampaign(true)
  }

  const parseCSV = (file, senderRowId = null) => {
    if (senderRowId) {
      setSenderRows((previous) =>
        previous.map((row) =>
          row.id === senderRowId
            ? {
                ...row,
                csvFile: file,
                csvHeaders: [],
                csvRows: [],
                recipientCount: 0,
              }
            : row
        )
      )
    }

    if (!senderRowId) {
      setCsvFile(file)
    }

    const reader = new FileReader()

    reader.onload = (event) => {
      const text = String(event.target.result || '')
      const { headers, data } = parseCsvText(text)

      if (senderRowId) {
        setSenderRows((previous) =>
          previous.map((row) =>
            row.id === senderRowId
              ? {
                  ...row,
                  csvHeaders: headers,
                  csvRows: data,
                  recipientCount: data.length,
                }
              : row
          )
        )
        return
      }

      if (!headers.length) {
        setRecipientCount(0)
        setCsvHeaders([])
        setCsvRows([])
        return
      }

      setCsvHeaders(headers)
      setCsvRows(data)
      setRecipientCount(data.length)
    }

    reader.readAsText(file)
  }

  const buildCampaignPayload = () => {
    if (!campaignName.trim()) {
      alert('Please enter a campaign name.')
      return null
    }

    if (!csvFile) {
      alert('Please upload a CSV file.')
      return null
    }

    const existingCampaign = campaigns.find(
      (item) => item.id === editingCampaignId
    )

    const profileIds = selectedProfileIds.map(Number).filter(Boolean)
    const profileNames = profiles
      .filter((profile) => profileIds.includes(profile.id))
      .map((profile) => profile.name)

    return {
      id: editingCampaignId || Date.now(),
      name: campaignName.trim(),
      subject,
      body,
      htmlMode: Boolean(htmlMode || looksLikeHtml(body)),
      profileIds,
      profileId: profileIds[0] || null,
      profileName: profileNames.join(', ') || null,
      csvFile,
      attachment,
      csvHeaders,
      recipientRows: csvRows,
      csvName: csvFile.name,
      attachmentName: attachment?.name || null,
      attachmentMode,
      attachmentHtml,
      attachmentFormat,
      attachmentFileName,
      customVariables: {
        tfn: tfnValue,
      },
      recipients: recipientCount,
      delaySeconds: Number(delaySeconds),
      typingDelayMs: Number(typingDelayMs),
      sent: existingCampaign?.sent || 0,
      failed: existingCampaign?.failed || 0,
      nextRecipientIndex: existingCampaign?.nextRecipientIndex || 0,
      createdAt:
        existingCampaign?.createdAt || new Date().toLocaleString(),
      updatedAt: new Date().toLocaleString(),
      status: existingCampaign?.status || 'Draft',
    }
  }

  const saveCampaign = () => {
    const campaign = buildCampaignPayload()
    if (!campaign) return null

    setCampaigns((prev) =>
      editingCampaignId
        ? prev.map((item) => (item.id === editingCampaignId ? campaign : item))
        : [campaign, ...prev]
    )
    setEditingCampaignId(campaign.id)
    addActivity(
      'campaign',
      editingCampaignId ? 'Campaign updated' : 'Campaign created',
      `${campaign.name} has been saved.`
    )
    return campaign
  }

  const sendCurrentCampaign = async () => {
    const campaign = buildCampaignPayload()
    if (!campaign) return

    setCampaigns((prev) =>
      editingCampaignId
        ? prev.map((item) => (item.id === editingCampaignId ? campaign : item))
        : [campaign, ...prev]
    )
    setEditingCampaignId(campaign.id)

    const profile = profiles.find((item) =>
      campaign.profileIds.includes(item.id)
    )

    if (!profile) {
      alert('Select a Chrome profile before sending.')
      return
    }

    if (!profile.running) {
      const started = await startProfileAutomation(profile)
      if (!started) return
    }

    void runCampaignOnProfile(campaign, profile)
  }

  const sendSenderRow = async (row) => {
    if (row.status !== 'ready') {
      alert('Wait until this Chrome profile is ready in Gmail.')
      return
    }

    if (!row.csvRows?.length) {
      alert('Load a CSV file before sending from this profile.')
      return
    }

    const existingCampaign = row.campaignId
      ? campaigns.find((campaign) => campaign.id === row.campaignId)
      : null
    const campaign = {
      id: existingCampaign?.id || Date.now() + Number(row.profileId || 0),
      name: `${campaignName.trim() || 'Mail Campaign'} — ${
        row.profileName || `Chrome Profile ${row.profileId}`
      }`,
      subject: row.subject || '',
      body: row.body || '',
      htmlMode: looksLikeHtml(row.body || ''),
      profileIds: [Number(row.profileId)],
      profileId: Number(row.profileId),
      profileName: row.profileName,
      csvFile: row.csvFile,
      attachment,
      csvHeaders: row.csvHeaders || [],
      recipientRows: row.csvRows || [],
      csvName: row.csvFile?.name || null,
      attachmentName: attachment?.name || null,
      attachmentMode,
      attachmentHtml,
      attachmentFormat,
      attachmentFileName,
      customVariables: {
        tfn: tfnValue,
      },
      recipients: row.recipientCount || row.csvRows.length,
      delaySeconds: Number(delaySeconds),
      typingDelayMs: Number(typingDelayMs),
      sent: existingCampaign?.sent || 0,
      failed: existingCampaign?.failed || 0,
      nextRecipientIndex: existingCampaign?.nextRecipientIndex || 0,
      createdAt: existingCampaign?.createdAt || new Date().toLocaleString(),
      updatedAt: new Date().toLocaleString(),
      status: existingCampaign?.status || 'Draft',
    }

    setCampaigns((previous) =>
      existingCampaign
        ? previous.map((item) => (item.id === campaign.id ? campaign : item))
        : [campaign, ...previous]
    )
    setSenderRowField(row.id, 'campaignId', campaign.id)

    const profile = profiles.find((item) => item.id === row.profileId)
    if (!profile) {
      alert('This Chrome profile is no longer available.')
      return
    }

    if (!profile.running) {
      const started = await startProfileAutomation(profile)
      if (!started) return
    }

    void runCampaignOnProfile(campaign, profile)
  }

  const stopCampaign = async (campaign) => {
    if (!campaign?.id) return

    const result = await window.electronAPI?.stopCampaign?.(campaign.id)
    if (!result?.success) {
      alert(result?.error || 'This campaign is not currently running.')
      return
    }

    setCampaigns((previous) =>
      previous.map((item) =>
        item.id === campaign.id ? { ...item, status: 'Paused' } : item
      )
    )
    addActivity('profile', 'Campaign paused', `${campaign.name} was stopped.`)
  }

  const deleteCampaign = (campaign) => {
    const confirmed = window.confirm(
      `Delete "${campaign.name}"? This action cannot be undone.`
    )

    if (!confirmed) return

    setCampaigns((prev) => prev.filter((item) => item.id !== campaign.id))
    addActivity('campaign', 'Campaign deleted', `${campaign.name} was removed.`)
  }

  const startCampaign = (campaignId) => {
    const campaign = campaigns.find((item) => item.id === campaignId)
    const assignedProfileIds = campaign?.profileIds?.length
      ? campaign.profileIds
      : campaign?.profileId
        ? [campaign.profileId]
        : []
    const runningProfiles = profiles.filter(
      (profile) =>
        assignedProfileIds.includes(profile.id) && profile.running
    )

    if (!assignedProfileIds.length) {
      alert('Select at least one Chrome profile for this campaign first.')
      return
    }

    if (!runningProfiles.length) {
      alert('Start at least one assigned Chrome profile from Profiles first.')
      return
    }

    if (!campaign.recipientRows?.length) {
      alert('This campaign has no CSV recipient rows. Upload the CSV again.')
      return
    }

    void runCampaignOnProfile(campaign, runningProfiles[0])
  }

  const builtInTags = [
    { tag: '{{email}}', label: 'Email' },
    { tag: '{{name}}', label: 'Name' },
    { tag: '{{random_name}}', label: 'Random name' },
    { tag: '{{spanish_name}}', label: 'Spanish name' },
    { tag: '{{date}}', label: 'Date' },
    { tag: '{{id}}', label: 'Random ID' },
  ]

  const csvTagList = [
    ...csvHeaders
      .filter((header) => header.toLowerCase() !== 'email')
      .slice(0, 8)
      .map((header) => `{{${header}}}`),
  ]

  const previewRecipient = csvRows[0] || {}
  const previewRecipientValue = (key, fallback = '') => {
    const entry = Object.entries(previewRecipient).find(
      ([header]) => header.toLowerCase() === key
    )
    return String(entry?.[1] || fallback).trim()
  }
  const previewEmail = previewRecipientValue(
    'email',
    'recipient@example.com'
  )
  const previewName = previewRecipientValue(
    'name',
    previewEmail.split('@')[0].replace(/[._-]+/g, ' ').trim()
  )
  const previewTagValues = {
    '{{email}}': previewEmail,
    '{{name}}': previewName,
    '{{random_name}}': 'Emily Carter',
    '{{spanish_name}}': 'Lucía García',
    '{{date}}': new Intl.DateTimeFormat('en-IN', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    }).format(new Date()),
    '{{id}}': 'A7K2M9QX',
    '{{tfn}}': tfnValue,
  }

  const previewBody = Object.entries(previewTagValues).reduce(
    (value, [tag, replacement]) =>
      value.replaceAll(tag, replacement),
    body
  )
  const previewIsHtml = htmlMode || looksLikeHtml(previewBody)

  const insertTag = (tag) => {
    setBody((prev) => `${prev}${prev ? ' ' : ''}${tag}`)
  }

  const liveCampaign = editingCampaignId
    ? campaigns.find((campaign) => campaign.id === editingCampaignId)
    : null
  const liveSent = liveCampaign?.sent || 0
  const liveFailed = liveCampaign?.failed || 0
  const liveTotal = liveCampaign?.recipients ?? recipientCount
  const liveProgress = liveTotal
    ? Math.min(((liveSent + liveFailed) / liveTotal) * 100, 100)
    : 0
  const selectedProfile = profiles.find((profile) =>
    selectedProfileIds.includes(String(profile.id))
  )
  const compactStatus = liveCampaign?.status || (
    selectedProfile?.running ? 'Running' : 'Ready'
  )
  const primaryCampaignRunning = liveCampaign?.status === 'Running'

  const campaignComposer = (
    <div className="content compact-campaign-shell">
      <section className="page-title-row">
        <div>
          <span className="eyebrow">MAIL SYSTEM</span>
          <h2>Gmail Sender</h2>
          <p>One compact workspace for profiles, recipients and delivery.</p>
        </div>

        <button
          className="secondary-btn"
          onClick={handleNewSenderRow}
        >
          <Plus size={16} />
          New
        </button>
      </section>

      <section className="compact-send-panel">
        <div className="compact-row-number">1</div>

        <div className="compact-profile-cell">
          <span className={`compact-status-dot ${compactStatus.toLowerCase()}`} />
          <div>
            <strong>{selectedProfile?.name || 'No Chrome profile'}</strong>
            <span>{compactStatus.toLowerCase()}</span>
          </div>
          <select
            className="compact-profile-select"
            value={selectedProfileIds[0] || ''}
            onChange={(event) =>
              setSelectedProfileIds(event.target.value ? [event.target.value] : [])
            }
            aria-label="Chrome profile"
          >
            <option value="">Choose profile</option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
          {selectedProfile && (
            <div className="compact-profile-actions">
              <button type="button" onClick={() => openProfile(selectedProfile)}>
                Open
              </button>
              <button
                type="button"
                className="compact-delete-profile"
                onClick={() => deleteProfile(selectedProfile)}
                aria-label={`Delete ${selectedProfile.name}`}
                title="Delete profile"
              >
                <Trash2 size={13} />
              </button>
            </div>
          )}
        </div>

        <div className="compact-message-cell">
          <span className="compact-recipient-label">
            {selectedProfile?.name || 'recipient account'}
          </span>
          <input
            className="compact-subject-input"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder="Subject Line"
          />
          <textarea
            className="compact-body-input"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Body HTML or plain text"
            spellCheck="false"
          />
        </div>

        <div className="compact-progress-cell">
          <span>Sent / Total</span>
          <strong>
            {liveSent} <small>/ {liveTotal}</small>
          </strong>
          <div className="compact-progress-track">
            <span style={{ width: `${liveProgress}%` }} />
          </div>
          <small className="compact-failed">Failed: {liveFailed}</small>
        </div>

        <div className="compact-control-cell">
          <label className="compact-csv-name compact-recipient-upload">
            <Upload size={13} />
            <span>{csvFile?.name || 'No recipients.csv'}</span>
            <input
              type="file"
              accept=".csv,text/csv"
              onClick={(event) => {
                event.currentTarget.value = ''
              }}
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) parseCSV(file)
              }}
            />
          </label>
          <small>{recipientCount} recipients</small>
          {csvFile && (
            <button
              type="button"
              className="compact-clear-recipients"
              onClick={() => {
                setCsvFile(null)
                setCsvHeaders([])
                setCsvRows([])
                setRecipientCount(0)
              }}
            >
              Clear recipients
            </button>
          )}
          <button
            type="button"
            className="compact-send-button"
             onClick={() =>
               primaryCampaignRunning
                 ? stopCampaign(liveCampaign)
                 : sendCurrentCampaign()
             }
          >
             {primaryCampaignRunning ? <Square size={13} /> : <Play size={14} />}
             {primaryCampaignRunning ? 'Stop' : 'Send'}
          </button>
        </div>
      </section>

      {senderRows.map((row) => {
        const rowCampaign = row.campaignId
          ? campaigns.find((campaign) => campaign.id === row.campaignId)
          : null
        const rowSent = rowCampaign?.sent || 0
        const rowFailed = rowCampaign?.failed || 0
        const rowTotal = rowCampaign?.recipients ?? row.recipientCount ?? 0
        const rowProgress = rowTotal
          ? Math.min(((rowSent + rowFailed) / rowTotal) * 100, 100)
          : 0
        const rowStatus = rowCampaign?.status || row.status || 'waiting'

        return (
        <section className="compact-send-panel compact-sender-row" key={row.id}>
          <div className="compact-row-number">{row.rowNumber}</div>

          <div className="compact-profile-cell">
            <span className={`compact-status-dot ${row.status || 'waiting'}`} />
            <div>
              <strong>{row.profileName}</strong>
              <span>{rowStatus}</span>
            </div>
            <button
              type="button"
              className="compact-delete-profile compact-row-delete"
              onClick={() => {
                const profile = profiles.find(
                  (item) => item.id === row.profileId
                )
                if (profile) deleteProfile(profile)
              }}
              aria-label={`Delete Chrome Profile ${row.profileId}`}
              title="Delete profile"
            >
              <Trash2 size={13} />
            </button>
          </div>

          <div className="compact-message-cell">
            <span className="compact-recipient-label">
              Chrome Profile {row.profileId}
            </span>
            <input
              className="compact-subject-input"
              value={row.subject || ''}
              onChange={(event) =>
                setSenderRowField(row.id, 'subject', event.target.value)
              }
              placeholder="Subject Line"
            />
            <textarea
              className="compact-body-input"
              value={row.body || ''}
              onChange={(event) =>
                setSenderRowField(row.id, 'body', event.target.value)
              }
              placeholder="Body HTML"
              spellCheck="false"
            />
          </div>

          <div className="compact-progress-cell">
            <span>Sent / Total</span>
            <strong>
              {rowSent} <small>/ {rowTotal}</small>
            </strong>
            <div className="compact-progress-track">
              <span style={{ width: `${rowProgress}%` }} />
            </div>
            <small className="compact-failed">Failed: {rowFailed}</small>
          </div>

          <div className="compact-control-cell">
            <label className="compact-load-recipients">
              <Upload size={13} />
              <span>{row.csvFile?.name || 'Load recipients'}</span>
              <input
                type="file"
                accept=".csv,text/csv"
                onClick={(event) => {
                  event.currentTarget.value = ''
                }}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) parseCSV(file, row.id)
                }}
              />
            </label>
            <small>
              {row.recipientCount || 0} recipients
              {row.status !== 'ready' ? ' · Waiting for Gmail account' : ''}
            </small>
            <button
              type="button"
              className="compact-send-button"
              onClick={() =>
                rowCampaign?.status === 'Running'
                  ? stopCampaign(rowCampaign)
                  : sendSenderRow(row)
              }
              disabled={
                row.status !== 'ready' ||
                !row.recipientCount
              }
            >
              {rowCampaign?.status === 'Running' ? (
                <Square size={13} />
              ) : (
                <Play size={14} />
              )}
              {rowCampaign?.status === 'Running' ? 'Stop' : 'Send'}
            </button>
          </div>
        </section>
        )
      })}

      <section className="campaign-builder">
        <div className="campaign-form">
          <div className="form-card campaign-details-card">
            <div className="form-card-header">
              <div>
                <h3>Campaign Details</h3>
                <p>Basic information for this campaign.</p>
              </div>
            </div>

            <label className="field-label">Campaign Name</label>
            <input
              className="text-input"
              value={campaignName}
              onChange={(e) => setCampaignName(e.target.value)}
              placeholder="e.g. September Newsletter"
            />
          </div>

          <div className="form-card profile-picker-card">
            <div className="form-card-header">
              <div>
                <h3>Run with Profiles</h3>
                <p>Choose one or more Chrome accounts for this campaign.</p>
              </div>
            </div>

            <label className="field-label">Chrome Profiles</label>
            <div className="profile-picker">
              {profiles.map((profile) => (
                <label className="profile-option" key={profile.id}>
                  <input
                    type="checkbox"
                    checked={selectedProfileIds.includes(String(profile.id))}
                    onChange={() =>
                      setSelectedProfileIds((current) =>
                        current.includes(String(profile.id))
                          ? current.filter(
                              (id) => id !== String(profile.id)
                            )
                          : [...current, String(profile.id)]
                      )
                    }
                  />
                  <span className="profile-option-copy">
                    <strong>{profile.name}</strong>
                    <small>
                      {profile.running ? 'Running' : profile.status}
                    </small>
                  </span>
                </label>
              ))}
            </div>

            {!profiles.length && (
              <p className="field-hint">
                Add a Chrome profile before starting this campaign.
              </p>
            )}

            {profiles.length > 0 && (
              <p className="selection-hint">
                {selectedProfileIds.length} profile
                {selectedProfileIds.length === 1 ? '' : 's'} selected
              </p>
            )}
          </div>

          <div className="form-card delay-card">
            <div className="form-card-header">
              <div>
                <h3>Sending Delay</h3>
                <p>Wait between each recipient to control the send pace.</p>
              </div>
              <div className="delay-value">
                <Clock3 size={15} />
                <strong>{delaySeconds}s</strong>
              </div>
            </div>

            <input
              className="delay-slider"
              type="range"
              min="0"
              max="60"
              step="1"
              value={delaySeconds}
              style={{
                background: `linear-gradient(to right, #24272d 0%, #24272d ${
                  (Number(delaySeconds) / 60) * 100
                }%, #e5e7eb ${
                  (Number(delaySeconds) / 60) * 100
                }%, #e5e7eb 100%)`,
              }}
              onChange={(e) => setDelaySeconds(Number(e.target.value))}
              aria-label="Delay between emails in seconds"
            />
            <div className="delay-scale">
              <span>0 sec</span>
              <span>60 sec</span>
            </div>
          </div>

          <div className="form-card delay-card">
            <div className="form-card-header">
              <div>
                <h3>Typing Delay</h3>
                <p>Add a pause between each typed character in Gmail.</p>
              </div>
              <div className="delay-value">
                <Keyboard size={15} />
                <strong>{typingDelayMs}ms</strong>
              </div>
            </div>

            <input
              className="delay-slider"
              type="range"
              min="0"
              max="250"
              step="10"
              value={typingDelayMs}
              style={{
                background: `linear-gradient(to right, #24272d 0%, #24272d ${
                  (Number(typingDelayMs) / 250) * 100
                }%, #e5e7eb ${
                  (Number(typingDelayMs) / 250) * 100
                }%, #e5e7eb 100%)`,
              }}
              onChange={(e) => setTypingDelayMs(Number(e.target.value))}
              aria-label="Typing delay in milliseconds"
            />
            <div className="delay-scale">
              <span>0 ms</span>
              <span>250 ms</span>
            </div>
          </div>

          <div className="form-card custom-tfn-card">
            <div className="form-card-header">
              <div>
                <h3>TFN Variable</h3>
                <p>Use this value wherever you add {'{{tfn}}'}.</p>
              </div>
            </div>

            <div className="custom-variable-row">
              <button
                type="button"
                className="tag custom-variable-tag"
                onClick={() => insertTag('{{tfn}}')}
                title="Insert {{tfn}}"
              >
                {'{{tfn}}'}
              </button>
              <input
                className="text-input custom-variable-input"
                value={tfnValue}
                onChange={(event) => setTfnValue(event.target.value)}
                placeholder="TFN value"
                aria-label="TFN value"
              />
            </div>
          </div>

          <div className="form-card recipients-card">
            <div className="form-card-header">
              <div>
                <h3>Recipients</h3>
                <p>Upload a CSV containing your recipient list.</p>
              </div>
            </div>

            {csvFile ? (
              <div className="selected-file">
                <div className="file-icon">
                  <Upload size={18} />
                </div>
                <div className="file-info">
                  <strong>{csvFile.name}</strong>
                  <span>
                    {recipientCount} recipient
                    {recipientCount === 1 ? '' : 's'} detected
                  </span>
                </div>
                <button
                  type="button"
                  className="remove-file"
                  onClick={() => {
                    setCsvFile(null)
                    setCsvHeaders([])
                    setRecipientCount(0)
                  }}
                >
                  <X size={14} />
                  Remove
                </button>
              </div>
            ) : (
              <label className="upload-box">
                <Upload size={24} />
                <strong>Upload CSV</strong>
                <span>Click to choose a .csv file</span>

                <input
                  type="file"
                  accept=".csv,text/csv"
                  onClick={(e) => {
                    e.currentTarget.value = ''
                  }}
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) parseCSV(file)
                  }}
                />
              </label>
            )}

            {csvHeaders.length > 0 && (
              <div className="csv-tags">
                <span>CSV columns:</span>
                {csvHeaders.map((header) => (
                  <button
                    key={header}
                    type="button"
                    onClick={() => insertTag(`{{${header}}}`)}
                  >
                    {`{{${header}}}`}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="form-card attachment-card">
            <div className="form-card-header">
              <div>
                <h3>Attachment</h3>
                <p>Convert HTML into a real file or upload an existing one.</p>
              </div>
            </div>

            <div className="attachment-mode-tabs">
              <button
                type="button"
                className={attachmentMode === 'html' ? 'active' : ''}
                onClick={() => setAttachmentMode('html')}
              >
                Generate from HTML
              </button>
              <button
                type="button"
                className={attachmentMode === 'upload' ? 'active' : ''}
                onClick={() => setAttachmentMode('upload')}
              >
                Upload File
              </button>
            </div>

            {attachmentMode === 'html' ? (
              <div className="attachment-generator">
                <label className="field-label" htmlFor="attachment-file-name">
                  File name
                </label>
                <input
                  id="attachment-file-name"
                  className="text-input"
                  value={attachmentFileName}
                  onChange={(event) =>
                    setAttachmentFileName(event.target.value)
                  }
                  placeholder="e.g. monthly-report"
                />
                {/\{\{[^}]+\}\}/.test(attachmentFileName) && (
                  <span className="attachment-template-hint">
                    Preview:{' '}
                    {resolvePreviewAttachmentTags(attachmentFileName, {
                      tfn: tfnValue,
                    })}
                    .{ATTACHMENT_FORMATS.find(
                      (format) => format.value === attachmentFormat
                    )?.extension || 'html'}{' '}
                    · final filename resolves per recipient when sending
                  </span>
                )}

                <label className="field-label" htmlFor="attachment-format">
                  Output format
                </label>
                <select
                  id="attachment-format"
                  className="text-input attachment-format-select"
                  value={attachmentFormat}
                  onChange={(event) => setAttachmentFormat(event.target.value)}
                >
                  {ATTACHMENT_FORMATS.map((format) => (
                    <option key={format.value} value={format.value}>
                      {format.label}
                    </option>
                  ))}
                </select>

                <label className="field-label" htmlFor="attachment-html">
                  HTML code
                </label>
                <textarea
                  id="attachment-html"
                  className="attachment-html-editor"
                  value={attachmentHtml}
                  onChange={(event) => setAttachmentHtml(event.target.value)}
                  placeholder="<h1>Report</h1><p>Content goes here...</p>"
                  spellCheck="false"
                />

                <button
                  type="button"
                  className="primary-btn attachment-generate-btn"
                  onClick={generateAttachment}
                  disabled={isGeneratingAttachment}
                >
                  <Paperclip size={16} />
                  {isGeneratingAttachment
                    ? 'Converting...'
                    : 'Convert & Attach'}
                </button>
              </div>
            ) : (
              <label className="upload-box compact">
                <Paperclip size={23} />
                <strong>Upload Existing File</strong>
                <span>PDF, DOCX, XLSX, PPTX, images and other files</span>

                <input
                  type="file"
                  accept="*/*"
                  onClick={(e) => {
                    e.currentTarget.value = ''
                  }}
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) {
                      setAttachment(file)
                      setAttachmentMode('upload')
                    }
                  }}
                />
              </label>
            )}

            {attachment && (
              <div className="selected-file attachment-result">
                <div className="file-icon">
                  <Paperclip size={18} />
                </div>
                <div className="file-info">
                  <strong>{attachment.name}</strong>
                  <span>
                    {attachment.size
                      ? `${(attachment.size / 1024 / 1024).toFixed(2)} MB`
                      : 'Ready to attach'}
                  </span>
                </div>
                <button
                  type="button"
                  className="remove-file"
                  onClick={() => setAttachment(null)}
                >
                  <X size={14} />
                  Remove
                </button>
              </div>
            )}
          </div>

          <div className="form-card subject-card">
            <div className="form-card-header">
              <div>
                <h3>Subject (Optional)</h3>
                <p>Add a subject or leave it blank.</p>
              </div>
            </div>

            <label className="field-label">Email Subject</label>
            <input
              className="text-input"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Enter email subject"
            />
          </div>

          <div className="form-card body-card">
            <div className="form-card-header">
              <div>
                <h3>Email Body (Optional)</h3>
                <p>Add plain text or HTML, or leave it blank.</p>
              </div>

              <button
                type="button"
                className={`mode-btn ${htmlMode ? 'active' : ''}`}
                onClick={() => setHtmlMode((value) => !value)}
              >
                <Code size={15} />
                {htmlMode ? 'HTML' : 'Text'}
              </button>
            </div>

            <textarea
              className="body-editor"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={
                htmlMode
                  ? '<h1>Hello {{name}}</h1><p>Your message here...</p>'
                  : 'Hello {{name}},\n\nWrite your email here...'
              }
              spellCheck="false"
            />

            {htmlMode && (
              <div className="html-note">
                HTML mode is enabled. The saved body will remain HTML for the
                automation layer.
              </div>
            )}
          </div>

          <div className="form-card tags-card">
            <div className="form-card-header">
              <div>
                <h3>Tags / Variables</h3>
                <p>Insert CSV values dynamically into your email.</p>
              </div>
            </div>

            <div className="tag-group">
              <span className="tag-group-label">Built-in personalization</span>
              <div className="tag-list">
                {builtInTags.map(({ tag, label }) => (
                  <button
                    type="button"
                    className="tag tag-with-label"
                    key={tag}
                    onClick={() => insertTag(tag)}
                    title={`Insert ${tag}`}
                  >
                    <strong>{label}</strong>
                    <small>{tag}</small>
                  </button>
                ))}
              </div>
            </div>

            {csvTagList.length > 0 && (
              <div className="tag-group">
                <span className="tag-group-label">CSV columns</span>
                <div className="tag-list">
                  {csvTagList.map((tag) => (
                    <button
                      type="button"
                      className="tag"
                      key={tag}
                      onClick={() => insertTag(tag)}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <p className="tag-help">
              <strong>{'{{id}}'}</strong> creates a unique uppercase
              letters-and-numbers ID for each recipient when the campaign runs.
            </p>
          </div>

          <div className="campaign-footer">
            <button
              type="button"
              className="secondary-btn"
              onClick={() => setShowCreateCampaign(false)}
            >
              Cancel
            </button>

            <button type="button" className="primary-btn" onClick={saveCampaign}>
              <Save size={17} />
              Save Campaign
            </button>
          </div>
        </div>

        <div className="preview-card">
          <div className="preview-header">
            <div>
              <span className="eyebrow">LIVE PREVIEW</span>
              <h3>Email Preview</h3>
            </div>
            <Eye size={19} />
          </div>

          <div className="email-preview">
            <div className="preview-meta">
              <span>Subject</span>
              <strong>{subject || 'Your subject'}</strong>
            </div>

            <div className="preview-divider" />

            <div
              className="preview-body"
              dangerouslySetInnerHTML={{
                __html:
                  previewIsHtml && previewBody
                     ? previewBody
                     : previewBody
                         ? previewBody.replace(/\n/g, '<br />')
                        : '<span class="preview-empty">Your email body will appear here.</span>',
              }}
            />
          </div>

          <div className="preview-stats">
            <div>
              <span>Recipients</span>
              <strong>{recipientCount}</strong>
            </div>
            <div>
              <span>Attachment</span>
              <strong>{attachment ? '1' : '0'}</strong>
            </div>
            <div>
              <span>Profile</span>
              <strong>
                {selectedProfileIds.length
                  ? `${selectedProfileIds.length} selected`
                  : 'Not set'}
              </strong>
            </div>
            <div>
              <span>Delay</span>
              <strong>{delaySeconds}s</strong>
            </div>
            <div>
              <span>Typing</span>
              <strong>{typingDelayMs}ms</strong>
            </div>
          </div>
        </div>
      </section>
    </div>
  )

  return (
    <div className="app compact-campaign-mode">
      <main className="main">{campaignComposer}</main>
    </div>
  )

  return (
    <div
      className={`app ${
        active === 'Campaigns' && showCreateCampaign
          ? 'compact-campaign-mode'
          : ''
      }`}
    >
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">
            <Mail size={20} />
          </div>
          <span>Mail System</span>
        </div>

        <div className="menu-label">MAIN MENU</div>

        <nav>
          {menu.map(({ name, icon: Icon }) => (
            <button
              key={name}
              className={`nav-item ${active === name ? 'active' : ''}`}
              onClick={() => setActive(name)}
            >
              <Icon size={18} />
              <span>{name}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="system-status">
            <span className="status-dot" />
            System Ready
          </div>
          <div className="version">v1.0.0</div>
        </div>
      </aside>

      <main className="main">
        <header className="header">
          <div>
            <h1>{active}</h1>
            <p>
              {active === 'Profiles'
                ? 'Manage your Chrome automation profiles'
                : active === 'Campaigns'
                  ? 'Create and manage email campaigns'
                  : active === 'Activity Log'
                    ? 'Review profile, campaign and delivery events'
                    : active === 'Settings'
                      ? 'Configure automation defaults and safeguards'
                  : 'Manage your automation system'}
            </p>
          </div>

          <button className="profile-button">
            <div className="avatar">A</div>
            <div>
              <strong>Admin</strong>
              <small>Local System</small>
            </div>
          </button>
        </header>

        {active === 'Dashboard' && (
          <div className="content">
            <section className="welcome">
              <div>
                <span className="eyebrow">AUTOMATION PANEL</span>
                <h2>Welcome back 👋</h2>
                <p>
                  Manage profiles, campaigns and automation from one place.
                </p>
              </div>

              <button
                className="primary-btn"
                onClick={() => {
                  setActive('Profiles')
                  openAddProfile()
                }}
              >
                <Plus size={18} />
                Add Profile
              </button>
            </section>

            <section className="stats">
              <div className="stat-card">
                <div className="stat-top">
                  <span>Chrome Profiles</span>
                  <Users size={20} />
                </div>
                <strong>{profiles.length}</strong>
                <small>
                  {profiles.length ? 'Profiles available' : 'No profiles added'}
                </small>
              </div>

              <div className="stat-card">
                <div className="stat-top">
                  <span>Running</span>
                  <Play size={20} />
                </div>
                <strong>{profiles.filter((p) => p.running).length}</strong>
                <small>Active automations</small>
              </div>

              <div className="stat-card">
                <div className="stat-top">
                  <span>Campaigns</span>
                  <Megaphone size={20} />
                </div>
                <strong>{campaigns.length}</strong>
                <small>Saved campaigns</small>
              </div>

              <div className="stat-card">
                <div className="stat-top">
                  <span>System Status</span>
                  <Activity size={20} />
                </div>
                <strong className="ready">Ready</strong>
                <small>Automation is idle</small>
              </div>
            </section>

            <section className="grid">
              <div className="panel">
                <div className="panel-header">
                  <div>
                    <h3>Quick Start</h3>
                    <p>Start your first automation</p>
                  </div>
                </div>

                <div className="quick-actions">
                  <button
                    className="action-card"
                    onClick={() => {
                      setActive('Profiles')
                      openAddProfile()
                    }}
                  >
                    <div className="action-icon">
                      <Plus size={21} />
                    </div>
                    <div>
                      <strong>Add Chrome Profile</strong>
                      <span>Create a browser profile and login manually.</span>
                    </div>
                  </button>

                  <button
                    className="action-card"
                    onClick={() => {
                      setActive('Campaigns')
                      openCampaignCreator()
                    }}
                  >
                    <div className="action-icon">
                      <Upload size={21} />
                    </div>
                    <div>
                      <strong>Create Campaign</strong>
                      <span>Upload CSV, attachment and email content.</span>
                    </div>
                  </button>

                  <button
                    className="action-card"
                    onClick={() => setActive('Profiles')}
                  >
                    <div className="action-icon">
                      <Play size={21} />
                    </div>
                    <div>
                      <strong>Start Campaign</strong>
                      <span>Run automation using a selected profile.</span>
                    </div>
                  </button>
                </div>
              </div>

              <div className="panel">
                <div className="panel-header">
                  <div>
                    <h3>Profiles</h3>
                    <p>Chrome automation profiles</p>
                  </div>
                </div>

                <div className="mini-profile-list">
                  {profiles.map((profile) => (
                    <div className="mini-profile" key={profile.id}>
                      <Globe size={20} />
                      <div>
                        <strong>{profile.name}</strong>
                        <span>{profile.status}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          </div>
        )}

        {active === 'Profiles' && (
          <div className="content">
            <section className="page-title-row">
              <div>
                <span className="eyebrow">BROWSER PROFILES</span>
                <h2>Chrome Profiles</h2>
                <p>Create and manage individual browser sessions.</p>
              </div>

              <button
                className="primary-btn"
                onClick={openAddProfile}
              >
                <Plus size={18} />
                Add Profile
              </button>
            </section>

            <section className="profiles-list">
              {profiles.map((profile) => (
                <div className="profile-card" key={profile.id}>
                  <div className="profile-main">
                    <div className="chrome-icon">
                      <Globe size={25} />
                    </div>

                    <div className="profile-info">
                      <div className="profile-name-row">
                        <h3>{profile.name}</h3>

                        <span className={`profile-status ${profile.status}`}>
                          <span />
                          {profile.status === 'running'
                            ? 'Running'
                            : profile.status === 'online'
                              ? 'Logged In'
                              : 'Not Logged In'}
                        </span>
                      </div>

                      <p>Chrome automation profile</p>

                      <div className="profile-meta">
                        <span>Last active: {profile.lastActive}</span>
                        <span>Profile ID: #{profile.id}</span>
                        <span>Port: {profile.debugPort || 9222}</span>
                      </div>

                        {getProfileCampaigns(campaigns, profile.id).length > 0 && (
                          <div className="profile-campaigns">
                            <span>Assigned campaigns</span>
                            <strong>
                              {getProfileCampaigns(campaigns, profile.id)
                                .map((campaign) => campaign.name)
                                .join(', ')}
                            </strong>
                          </div>
                        )}

                      <ProfileStats
                        campaigns={campaigns}
                        profileId={profile.id}
                      />
                    </div>
                  </div>

                  <div className="profile-actions">
                    <button
                      className="secondary-btn"
                      onClick={() => openProfile(profile)}
                    >
                      <Globe size={16} />
                      Open
                    </button>

                    <button
                      className={profile.running ? 'stop-btn' : 'start-btn'}
                      onClick={() => toggleStart(profile)}
                    >
                      {profile.running ? (
                        <>
                          <Square size={15} />
                          Stop
                        </>
                      ) : (
                        <>
                          <Play size={15} />
                          Start
                        </>
                      )}
                    </button>

                    <div className="profile-menu-wrap">
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`Actions for ${profile.name}`}
                        aria-expanded={openProfileMenuId === profile.id}
                        onClick={(event) => {
                          event.stopPropagation()
                          setOpenProfileMenuId((currentId) =>
                            currentId === profile.id ? null : profile.id
                          )
                        }}
                      >
                        <MoreVertical size={17} />
                      </button>

                      {openProfileMenuId === profile.id && (
                        <div className="profile-menu" role="menu">
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => openRenameProfile(profile)}
                          >
                            <Pencil size={14} />
                            Rename profile
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="danger"
                            onClick={() => deleteProfile(profile)}
                          >
                            <Trash2 size={14} />
                            Delete profile
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </section>

            {showAdd && (
              <div
                className="modal-backdrop"
                onClick={() => setShowAdd(false)}
              >
                <div
                  className="modal"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="modal-icon">
                    <Globe size={24} />
                  </div>

                  <h2>
                    {editingProfileId !== null
                      ? 'Rename Chrome Profile'
                      : 'Add Chrome Profile'}
                  </h2>
                  <p>
                    {editingProfileId !== null
                      ? 'Update the name used to identify this browser profile.'
                      : 'Give this browser profile a name. You can then open it and login manually.'}
                  </p>

                  <label>Profile Name</label>
                  <input
                    autoFocus
                    value={profileName}
                    onChange={(e) => setProfileName(e.target.value)}
                    placeholder="e.g. Gmail Account 1"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') addProfile()
                    }}
                  />

                  <div className="modal-actions">
                    <button
                      className="secondary-btn"
                      onClick={() => {
                        setShowAdd(false)
                        setEditingProfileId(null)
                      }}
                    >
                      Cancel
                    </button>

                    <button className="primary-btn" onClick={addProfile}>
                      {editingProfileId !== null ? (
                        <Pencil size={17} />
                      ) : (
                        <Plus size={17} />
                      )}
                      {editingProfileId !== null
                        ? 'Save Name'
                        : 'Create Profile'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {active === 'Campaigns' && !showCreateCampaign && (
          <div className="content">
            <section className="page-title-row">
              <div>
                <span className="eyebrow">EMAIL CAMPAIGNS</span>
                <h2>Campaigns</h2>
                <p>Create, review and manage your email campaigns.</p>
              </div>

              <button
                className="primary-btn"
                onClick={openCampaignCreator}
              >
                <Plus size={18} />
                Create Campaign
              </button>
            </section>

            {campaigns.length === 0 ? (
              <div className="empty-campaign">
                <div className="placeholder-icon">
                  <Megaphone size={28} />
                </div>
                <h2>No campaigns yet</h2>
                <p>
                  Create a campaign with recipients, attachment, subject and
                  email body.
                </p>
                <button
                  className="primary-btn"
                  onClick={openCampaignCreator}
                >
                  <Plus size={17} />
                  Create Campaign
                </button>
              </div>
            ) : (
              <section className="campaign-list">
                {campaigns.map((campaign) => (
                  <div className="campaign-card" key={campaign.id}>
                    <div className="campaign-card-main">
                      <div className="campaign-icon">
                        <Megaphone size={19} />
                      </div>

                      <div className="campaign-info">
                        <div className="campaign-title-row">
                          <h3>{campaign.name}</h3>
                          <span
                            className={`campaign-status ${(
                              campaign.status || 'Draft'
                            ).toLowerCase()}`}
                          >
                            {campaign.status || 'Draft'}
                          </span>
                        </div>

                        <p className="campaign-subject">
                          <Mail size={14} />
                          {campaign.subject}
                        </p>

                        <p className="campaign-profile">
                          <Globe size={13} />
                          {campaign.profileName ||
                            profiles
                              .filter((profile) =>
                                campaign.profileIds?.length
                                  ? campaign.profileIds.includes(profile.id)
                                  : profile.id === campaign.profileId
                              )
                              .map((profile) => profile.name)
                              .join(', ') ||
                            'No profile assigned'}
                          <span>
                            · {campaign.delaySeconds ?? 0}s delay
                          </span>
                          <span>
                            · {campaign.typingDelayMs ?? 0}ms typing
                          </span>
                        </p>

                        <div className="campaign-meta">
                          <span>
                            <Users size={13} />
                            {campaign.recipients} recipient
                            {campaign.recipients === 1 ? '' : 's'}
                          </span>
                          <span>
                            <Upload size={13} />
                            {campaign.csvName}
                          </span>
                          {campaign.attachmentName && (
                            <span>
                              <Paperclip size={13} />
                              {campaign.attachmentName}
                            </span>
                          )}
                        </div>

                        <div className="campaign-progress">
                          <span>
                            <strong>{campaign.sent || 0}</strong> sent
                          </span>
                          <span>
                            <strong>
                              {Math.max(
                                (campaign.recipients || 0) -
                                  (campaign.sent || 0) -
                                  (campaign.failed || 0),
                                0
                              )}
                            </strong>{' '}
                            pending
                          </span>
                          <span>
                            <strong>{campaign.failed || 0}</strong> failed
                          </span>
                        </div>

                        <span className="campaign-date">
                          <CalendarDays size={12} />
                          Updated {campaign.updatedAt || campaign.createdAt}
                        </span>
                      </div>
                    </div>

                    <div className="campaign-actions">
                      <button
                        type="button"
                        className="start-btn"
                        onClick={() => startCampaign(campaign.id)}
                      >
                        <Play size={15} />
                        {campaign.status === 'Running'
                          ? 'Running'
                          : campaign.status === 'Completed'
                            ? 'Completed'
                            : 'Start'}
                      </button>
                      <button
                        type="button"
                        className="icon-btn campaign-edit"
                        onClick={() => openCampaignEditor(campaign)}
                        aria-label={`Edit ${campaign.name}`}
                        title="Edit campaign"
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn campaign-delete"
                        onClick={() => deleteCampaign(campaign)}
                        aria-label={`Delete ${campaign.name}`}
                        title="Delete campaign"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                ))}
              </section>
            )}
          </div>
        )}

        {active === 'Campaigns' &&
          showCreateCampaign &&
          campaignComposer}

        {active === 'Activity Log' && (
          <div className="content">
            <section className="page-title-row">
              <div>
                <span className="eyebrow">SYSTEM ACTIVITY</span>
                <h2>Activity Log</h2>
                <p>Track profile actions, campaign runs and email delivery.</p>
              </div>

              <button
                type="button"
                className="secondary-btn"
                onClick={() => setActivityLog([])}
                disabled={!activityLog.length}
              >
                Clear log
              </button>
            </section>

            {activityLog.length === 0 ? (
              <div className="panel empty-activity">
                <div className="placeholder-icon">
                  <Activity size={28} />
                </div>
                <h2>No activity yet</h2>
                <p>Profile and campaign events will appear here.</p>
              </div>
            ) : (
              <section className="panel activity-panel">
                <div className="activity-list">
                  {activityLog.map((event) => (
                    <div className="activity-item" key={event.id}>
                      <div className={`activity-icon ${event.type}`}>
                        {event.type === 'success' || event.type === 'send' ? (
                          <CircleCheck size={16} />
                        ) : (
                          <Activity size={16} />
                        )}
                      </div>
                      <div className="activity-copy">
                        <strong>{event.title}</strong>
                        <span>{event.detail}</span>
                      </div>
                      <time>{event.time}</time>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        {active === 'Settings' && (
          <div className="content">
            <section className="page-title-row">
              <div>
                <span className="eyebrow">AUTOMATION SETTINGS</span>
                <h2>Settings</h2>
                <p>Set defaults that control new campaign runs.</p>
              </div>
            </section>

            <div className="settings-grid">
              <section className="panel settings-card">
                <div className="panel-header">
                  <div>
                    <h3>Sending defaults</h3>
                    <p>These values are used when creating a new campaign.</p>
                  </div>
                </div>

                <div className="settings-body">
                  <div className="setting-row setting-range">
                    <div>
                      <strong>Default sending delay</strong>
                      <span>Wait time between two recipients.</span>
                    </div>
                    <div className="setting-range-control">
                      <input
                        type="range"
                        min="0"
                        max="60"
                        value={settings.defaultDelay}
                        onChange={(event) => {
                          setSettings((current) => ({
                            ...current,
                            defaultDelay: Number(event.target.value),
                          }))
                          setSettingsSaved(false)
                        }}
                      />
                      <strong>{settings.defaultDelay}s</strong>
                    </div>
                  </div>

                  <div className="setting-row">
                    <div>
                      <strong>Confirm before sending</strong>
                      <span>Ask before a campaign starts sending emails.</span>
                    </div>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={settings.confirmBeforeSend}
                        onChange={(event) => {
                          setSettings((current) => ({
                            ...current,
                            confirmBeforeSend: event.target.checked,
                          }))
                          setSettingsSaved(false)
                        }}
                      />
                      <span />
                    </label>
                  </div>

                  <div className="settings-actions">
                    <button
                      type="button"
                      className="primary-btn"
                      onClick={() => {
                        setSettingsSaved(true)
                        addActivity(
                          'system',
                          'Settings updated',
                          'Automation preferences were saved.'
                        )
                      }}
                    >
                      <Save size={16} />
                      Save Settings
                    </button>
                    {settingsSaved && <span>Saved</span>}
                  </div>
                </div>
              </section>

              <section className="panel settings-card">
                <div className="panel-header">
                  <div>
                    <h3>System overview</h3>
                    <p>Current local automation state.</p>
                  </div>
                </div>
                <div className="settings-overview">
                  <div>
                    <span>Chrome profiles</span>
                    <strong>{profiles.length}</strong>
                  </div>
                  <div>
                    <span>Saved campaigns</span>
                    <strong>{campaigns.length}</strong>
                  </div>
                  <div>
                    <span>Running profiles</span>
                    <strong>{profiles.filter((profile) => profile.running).length}</strong>
                  </div>
                  <div>
                    <span>Activity events</span>
                    <strong>{activityLog.length}</strong>
                  </div>
                </div>
              </section>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

export default App

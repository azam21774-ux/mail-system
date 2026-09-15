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
} from 'lucide-react'
import './App.css'

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

  const [showAdd, setShowAdd] = useState(false)
  const [profileName, setProfileName] = useState('')

  const [campaigns, setCampaigns] = useState([])
  const [showCreateCampaign, setShowCreateCampaign] = useState(false)
  const [editingCampaignId, setEditingCampaignId] = useState(null)

  const [campaignName, setCampaignName] = useState('')
  const [selectedProfileIds, setSelectedProfileIds] = useState([])
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [htmlMode, setHtmlMode] = useState(false)
  const [csvFile, setCsvFile] = useState(null)
  const [attachment, setAttachment] = useState(null)
  const [recipientCount, setRecipientCount] = useState(0)
  const [csvHeaders, setCsvHeaders] = useState([])
  const [csvRows, setCsvRows] = useState([])
  const [delaySeconds, setDelaySeconds] = useState(0)
  const activeCampaignRuns = useRef(new Set())

  const menu = [
    { name: 'Dashboard', icon: LayoutDashboard },
    { name: 'Profiles', icon: Users },
    { name: 'Campaigns', icon: Megaphone },
    { name: 'Activity Log', icon: Activity },
    { name: 'Settings', icon: Settings },
  ]

  const addProfile = () => {
    const name = profileName.trim()
    if (!name) return

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
  }

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

      const result = await window.electronAPI.runCampaign({
        campaignId: campaign.id,
        profileId: profile.id,
        port: profile.debugPort || 9222,
        recipients: campaign.recipientRows,
        subject: campaign.subject,
        body: campaign.body,
        htmlMode: campaign.htmlMode,
        delaySeconds: campaign.delaySeconds ?? 0,
        attachment: attachmentPayload,
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

  const runAssignedCampaignsForProfile = (profile) => {
    campaigns
      .filter((campaign) => {
        const assignedProfileIds = campaign.profileIds?.length
          ? campaign.profileIds
          : campaign.profileId
            ? [campaign.profileId]
            : []

        return (
          assignedProfileIds.includes(profile.id) &&
          campaign.status !== 'Completed' &&
          !activeCampaignRuns.current.has(campaign.id)
        )
      })
      .forEach((campaign) => {
        void runCampaignOnProfile(campaign, profile)
      })
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
      runAssignedCampaignsForProfile(profile)
    }
  }

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onCampaignProgress?.((progress) => {
      setCampaigns((prev) =>
        prev.map((campaign) =>
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
                lastRecipient: progress.recipientEmail || campaign.lastRecipient,
                lastError: progress.error || campaign.lastError,
              }
            : campaign
        )
      )
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
  }

  const resetCampaignForm = () => {
    setCampaignName('')
    setSelectedProfileIds(profiles[0] ? [String(profiles[0].id)] : [])
    setSubject('')
    setBody('')
    setHtmlMode(false)
    setCsvFile(null)
    setAttachment(null)
    setRecipientCount(0)
    setCsvHeaders([])
    setCsvRows([])
    setDelaySeconds(0)
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
    setRecipientCount(campaign.recipients)
    setCsvHeaders(campaign.csvHeaders || [])
    setCsvRows(campaign.recipientRows || [])
    setDelaySeconds(campaign.delaySeconds ?? 0)
    setEditingCampaignId(campaign.id)
    setActive('Campaigns')
    setShowCreateCampaign(true)
  }

  const parseCSV = (file) => {
    setCsvFile(file)

    const reader = new FileReader()

    reader.onload = (event) => {
      const text = String(event.target.result || '')
      const { headers, data } = parseCsvText(text)

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

  const saveCampaign = () => {
    if (!campaignName.trim()) {
      alert('Please enter a campaign name.')
      return
    }

    if (!csvFile) {
      alert('Please upload a CSV file.')
      return
    }

    if (!subject.trim()) {
      alert('Please enter a subject.')
      return
    }

    if (!body.trim()) {
      alert('Please enter the email body.')
      return
    }

    const existingCampaign = campaigns.find(
      (item) => item.id === editingCampaignId
    )

    const profileIds = selectedProfileIds.map(Number).filter(Boolean)
    const profileNames = profiles
      .filter((profile) => profileIds.includes(profile.id))
      .map((profile) => profile.name)

    const campaign = {
      id: editingCampaignId || Date.now(),
      name: campaignName.trim(),
      subject,
      body,
      htmlMode,
      profileIds,
      profileId: profileIds[0] || null,
      profileName: profileNames.join(', ') || null,
      csvFile,
      attachment,
      csvHeaders,
      recipientRows: csvRows,
      csvName: csvFile.name,
      attachmentName: attachment?.name || null,
      recipients: recipientCount,
      delaySeconds: Number(delaySeconds),
      sent: existingCampaign?.sent || 0,
      failed: existingCampaign?.failed || 0,
      createdAt:
        existingCampaign?.createdAt || new Date().toLocaleString(),
      updatedAt: new Date().toLocaleString(),
      status: existingCampaign?.status || 'Draft',
    }

    setCampaigns((prev) =>
      editingCampaignId
        ? prev.map((item) => (item.id === editingCampaignId ? campaign : item))
        : [campaign, ...prev]
    )
    setShowCreateCampaign(false)
    setEditingCampaignId(null)
    resetCampaignForm()
  }

  const deleteCampaign = (campaign) => {
    const confirmed = window.confirm(
      `Delete "${campaign.name}"? This action cannot be undone.`
    )

    if (!confirmed) return

    setCampaigns((prev) => prev.filter((item) => item.id !== campaign.id))
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

  const previewTagValues = {
    '{{random_name}}': 'Aarav Sharma',
    '{{spanish_name}}': 'Lucía García',
    '{{date}}': new Intl.DateTimeFormat('en-IN', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    }).format(new Date()),
    '{{id}}': 'A7K2M9QX',
  }

  const previewBody = Object.entries(previewTagValues).reduce(
    (value, [tag, replacement]) =>
      value.replaceAll(tag, replacement),
    body
  )

  const insertTag = (tag) => {
    setBody((prev) => `${prev}${prev ? ' ' : ''}${tag}`)
  }

  const campaignComposer = (
    <div className="content">
      <section className="page-title-row">
        <div>
          <span className="eyebrow">CAMPAIGN BUILDER</span>
          <h2>Create Campaign</h2>
          <p>Prepare recipients, attachments and your email content.</p>
        </div>

        <button
          className="secondary-btn"
          onClick={() => setShowCreateCampaign(false)}
        >
          <X size={17} />
          Close
        </button>
      </section>

      <section className="campaign-builder">
        <div className="campaign-form">
          <div className="form-card">
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

          <div className="form-card">
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

          <div className="form-card">
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

          <div className="form-card">
            <div className="form-card-header">
              <div>
                <h3>Attachment</h3>
                <p>Attach any file supported by your system.</p>
              </div>
            </div>

            {attachment && (
              <div className="selected-file">
                <div className="file-icon">
                  <Paperclip size={18} />
                </div>
                <div className="file-info">
                  <strong>{attachment.name}</strong>
                  <span>
                    {(attachment.size / 1024 / 1024).toFixed(2)} MB
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

            {!attachment && (
              <label className="upload-box compact">
                <Paperclip size={23} />
                <strong>Upload Attachment</strong>
                <span>PDF, DOCX, XLSX, ZIP, images and other files</span>

                <input
                  type="file"
                  onClick={(e) => {
                    e.currentTarget.value = ''
                  }}
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) setAttachment(file)
                  }}
                />
              </label>
            )}
          </div>

          <div className="form-card">
            <div className="form-card-header">
              <div>
                <h3>Subject</h3>
                <p>Write the subject your recipients will see.</p>
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

          <div className="form-card">
            <div className="form-card-header">
              <div>
                <h3>Email Body</h3>
                <p>Use plain text or HTML content.</p>
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

          <div className="form-card">
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
                   htmlMode && previewBody
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
          </div>
        </div>
      </section>
    </div>
  )

  return (
    <div className="app">
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
                  setShowAdd(true)
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
                      setShowAdd(true)
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
                onClick={() => setShowAdd(true)}
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

                        {campaigns.filter((campaign) =>
                          campaign.profileIds?.length
                            ? campaign.profileIds.includes(profile.id)
                            : campaign.profileId === profile.id
                        ).length > 0 && (
                          <div className="profile-campaigns">
                            <span>Assigned campaigns</span>
                            <strong>
                              {campaigns
                                .filter((campaign) =>
                                  campaign.profileIds?.length
                                    ? campaign.profileIds.includes(profile.id)
                                    : campaign.profileId === profile.id
                                )
                                .map((campaign) => campaign.name)
                                .join(', ')}
                            </strong>
                          </div>
                        )}
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

                    <button className="icon-btn">
                      <MoreVertical size={17} />
                    </button>
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

                  <h2>Add Chrome Profile</h2>
                  <p>
                    Give this browser profile a name. You can then open it and
                    login manually.
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
                      onClick={() => setShowAdd(false)}
                    >
                      Cancel
                    </button>

                    <button className="primary-btn" onClick={addProfile}>
                      <Plus size={17} />
                      Create Profile
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

        {active !== 'Dashboard' &&
          active !== 'Profiles' &&
          active !== 'Campaigns' && (
            <div className="content">
              <div className="panel page-placeholder">
                <div className="placeholder-icon">
                  {(() => {
                    const item = menu.find((m) => m.name === active)
                    const Icon = item?.icon || Activity
                    return <Icon size={28} />
                  })()}
                </div>
                <h2>{active}</h2>
                <p>This section is ready. We'll build it next.</p>
              </div>
            </div>
          )}
      </main>
    </div>
  )
}

export default App

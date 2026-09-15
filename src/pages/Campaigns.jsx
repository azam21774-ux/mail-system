import { useRef, useState } from 'react'
import {
  Upload,
  Paperclip,
  Play,
  X,
  Plus,
  Eye,
  Code2,
  FileText,
} from 'lucide-react'

const DEFAULT_TAGS = [
  '{{email}}',
  '{{name}}',
  '{{c3}}',
  '{{c4}}',
  '{{c5}}',
  '{{c6}}',
  '{{date}}',
  '{{3 words}}',
  '{{3 words_copy}}',
  '{{3wa}}',
  '{{3wa_copy}}',
  '{{5 words}}',
  '{{7num}}',
  '{{a3}}',
  '{{a4}}',
  '{{amnt}}',
  '{{dfgd}}',
  '{{id}}',
  '{{number}}',
  '{{r_add}}',
  '{{rand_name}}',
  '{{rand_name_copy}}',
  '{{rand_name_copy2}}',
  '{{rand_name_copy_copy}}',
  '{{s2n}}',
  '{{s2n_copy}}',
  '{{S8K}}',
  '{{S99KK}}',
  '{{S9K}}',
  '{{spanish_name}}',
  '{{spanish_name_copy}}',
  '{{spanishname2}}',
  '{{spanishname2_copy2}}',
  '{{spanishname2_copy3}}',
  '{{spanishname2_copy4}}',
  '{{w3}}',
  '{{w33}}',
]

export default function Campaigns() {
  const csvRef = useRef(null)
  const attachmentRef = useRef(null)

  const [csvFile, setCsvFile] = useState(null)
  const [attachment, setAttachment] = useState(null)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [htmlMode, setHtmlMode] = useState(false)
  const [preview, setPreview] = useState(false)
  const [tags, setTags] = useState(DEFAULT_TAGS)
  const [newTag, setNewTag] = useState('')

  const addTag = () => {
    const clean = newTag.trim()
    if (!clean) return

    const tag = clean.startsWith('{{') ? clean : `{{${clean}}}`

    if (!tags.includes(tag)) {
      setTags((prev) => [...prev, tag])
    }

    setNewTag('')
  }

  const insertTag = (tag) => {
    setBody((prev) => `${prev}${tag}`)
  }

  const handleCsv = (event) => {
    const file = event.target.files?.[0]
    if (file) setCsvFile(file)
  }

  const handleAttachment = (event) => {
    const file = event.target.files?.[0]
    if (file) setAttachment(file)
  }

  const removeCsv = () => {
    setCsvFile(null)
    if (csvRef.current) csvRef.current.value = ''
  }

  const removeAttachment = () => {
    setAttachment(null)
    if (attachmentRef.current) attachmentRef.current.value = ''
  }

  const startCampaign = () => {
    if (!csvFile) {
      alert('Please upload a CSV file first.')
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

    console.log('Campaign ready:', {
      csv: csvFile.name,
      attachment: attachment?.name || null,
      subject,
      body,
    })

    alert('Campaign configuration saved. Automation will be connected next.')
  }

  return (
    <div className="campaign-page">
      <div className="page-title-row">
        <div>
          <div className="eyebrow">CAMPAIGN BUILDER</div>
          <h1>Create Campaign</h1>
          <p>Prepare your CSV, attachment and email content.</p>
        </div>

        <button className="primary-button" onClick={startCampaign}>
          <Play size={17} />
          Start Campaign
        </button>
      </div>

      <div className="campaign-grid">
        <section className="campaign-card">
          <div className="card-heading">
            <div>
              <h2>Recipients</h2>
              <p>Upload your recipient CSV.</p>
            </div>
            <FileText size={21} />
          </div>

          <input
            ref={csvRef}
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={handleCsv}
          />

          {!csvFile ? (
            <button
              className="upload-box"
              onClick={() => csvRef.current?.click()}
            >
              <Upload size={24} />
              <strong>Upload CSV</strong>
              <span>CSV file containing your recipients</span>
            </button>
          ) : (
            <div className="selected-file">
              <div className="file-icon">
                <FileText size={20} />
              </div>
              <div className="file-info">
                <strong>{csvFile.name}</strong>
                <span>{Math.round(csvFile.size / 1024)} KB</span>
              </div>
              <button onClick={removeCsv}>
                <X size={18} />
              </button>
            </div>
          )}
        </section>

        <section className="campaign-card">
          <div className="card-heading">
            <div>
              <h2>Attachment</h2>
              <p>Attach any file you want to send.</p>
            </div>
            <Paperclip size={21} />
          </div>

          <input
            ref={attachmentRef}
            type="file"
            hidden
            onChange={handleAttachment}
          />

          {!attachment ? (
            <button
              className="upload-box"
              onClick={() => attachmentRef.current?.click()}
            >
              <Paperclip size={24} />
              <strong>Choose Attachment</strong>
              <span>Any file format</span>
            </button>
          ) : (
            <div className="selected-file">
              <div className="file-icon">
                <Paperclip size={20} />
              </div>
              <div className="file-info">
                <strong>{attachment.name}</strong>
                <span>{Math.round(attachment.size / 1024)} KB</span>
              </div>
              <button onClick={removeAttachment}>
                <X size={18} />
              </button>
            </div>
          )}
        </section>

        <section className="campaign-card full-width">
          <div className="card-heading">
            <div>
              <h2>Email Content</h2>
              <p>Use tags to personalize every recipient's email.</p>
            </div>

            <div className="editor-actions">
              <button
                className={!htmlMode ? 'active' : ''}
                onClick={() => setHtmlMode(false)}
              >
                <FileText size={16} />
                Editor
              </button>

              <button
                className={htmlMode ? 'active' : ''}
                onClick={() => setHtmlMode(true)}
              >
                <Code2 size={16} />
                HTML
              </button>

              <button onClick={() => setPreview((v) => !v)}>
                <Eye size={16} />
                Preview
              </button>
            </div>
          </div>

          <label className="field-label">Subject</label>

          <input
            className="text-input"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Enter email subject..."
          />

          <div className="body-toolbar">
            <span>Message Body</span>
            <small>
              {htmlMode ? 'HTML mode' : 'Rich content mode'}
            </small>
          </div>

          {preview ? (
            <div className="email-preview">
              <div className="preview-subject">
                {subject || 'No subject'}
              </div>

              <div
                dangerouslySetInnerHTML={{
                  __html: body || '<p>Your email preview will appear here.</p>',
                }}
              />
            </div>
          ) : (
            <textarea
              className="body-editor"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={
                htmlMode
                  ? '<p>Hello {{name}},</p>...'
                  : 'Write your email body here...'
              }
            />
          )}
        </section>

        <section className="campaign-card full-width">
          <div className="card-heading">
            <div>
              <h2>Tags & Variables</h2>
              <p>Click a tag to insert it into the email body.</p>
            </div>
          </div>

          <div className="tag-list">
            {tags.map((tag) => (
              <button
                key={tag}
                className="tag-chip"
                onClick={() => insertTag(tag)}
              >
                {tag}
              </button>
            ))}
          </div>

          <div className="create-tag">
            <input
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addTag()
              }}
              placeholder="Create custom tag, e.g. company"
            />

            <button onClick={addTag}>
              <Plus size={17} />
              Create
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}

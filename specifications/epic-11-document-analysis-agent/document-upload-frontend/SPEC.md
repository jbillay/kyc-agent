# Document Analysis Agent — Document Upload and Analysis Frontend

> GitHub Issue: [#55](https://github.com/jbillay/kyc-agent/issues/55)
> Epic: Document Analysis Agent (#52)
> Size: M (1-3 days) | Priority: High

## Context

The frontend needs a Documents tab in the case detail view where analysts can upload KYC documents, see their analysis status, view extracted data, and compare it against registry data. Uploading a document triggers the Document Analysis Agent automatically. Analysis status updates are pushed via WebSocket so the analyst sees results without refreshing.

## Requirements

### Functional

1. **Documents tab** in case detail view (alongside Entity, Ownership, Screening, Risk, Audit tabs)
2. **Drag-and-drop upload area**:
   - Accepts: PDF (`.pdf`), images (`.png`, `.jpg`, `.jpeg`), Word documents (`.doc`, `.docx`)
   - Maximum file size: 25 MB
   - Shows file type validation errors for unsupported types
   - Multiple file upload supported
3. **Upload progress indicator**: progress bar per file during upload
4. **Document list** showing:
   - Filename
   - Document type (classified by agent, or "Pending" before classification)
   - Upload date (formatted)
   - Analysis status badge: `pending` (grey), `analyzing` (blue/spinning), `analyzed` (green), `failed` (red)
   - File size
5. **Document detail view** (click a document to expand/open):
   - Extracted data fields displayed as a key-value table
   - Cross-reference results with match/mismatch icons per field
   - Discrepancy flags with severity color coding (red = critical, amber = warning, grey = info)
   - Authenticity check results (pass/fail/skipped)
   - Overall assessment badge: `verified` (green), `discrepancies_found` (amber), `concerns_raised` (red)
6. **Side-by-side comparison**: extracted data vs registry data with match/mismatch highlighting
   - Left column: "Document Data" (from extracted data)
   - Right column: "Registry Data" (from EntityProfile)
   - Row highlighting: green for match, red for mismatch, grey for not available
7. **Upload triggers Document Analysis Agent** automatically via API:
   - `POST /api/v1/cases/:id/documents` (multipart form upload)
   - Server stores file in MinIO, creates `documents` row, enqueues agent job
   - Response includes `documentId` for tracking
8. **Real-time status updates** via WebSocket:
   - Listen for `document:status_changed` events (documentId, status)
   - Listen for `document:analysis_complete` events (documentId, report)
   - Update document list and detail view reactively

### Non-Functional

- Upload completes in under 5 seconds for files up to 10 MB
- Document list renders smoothly with up to 50 documents per case
- Drag-and-drop works on Chrome, Firefox, Edge (latest versions)

## Technical Design

### File: `frontend/src/components/documents/DocumentsTab.vue`

```vue
<template>
  <div class="documents-tab">
    <DocumentUpload :case-id="caseId" @uploaded="onDocumentUploaded" />

    <div v-if="documents.length === 0 && !loading" class="empty-state">
      <p>No documents uploaded yet. Drag and drop files above to begin.</p>
    </div>

    <DocumentList
      v-if="documents.length > 0"
      :documents="documents"
      :selected-id="selectedDocumentId"
      @select="onDocumentSelect"
    />

    <DocumentDetail
      v-if="selectedDocument"
      :document="selectedDocument"
      :entity-profile="entityProfile"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';
import DocumentUpload from './DocumentUpload.vue';
import DocumentList from './DocumentList.vue';
import DocumentDetail from './DocumentDetail.vue';
import { useCaseStore } from '@/stores/case';
import { useSocketStore } from '@/stores/socket';
import api from '@/services/api';

const route = useRoute();
const caseStore = useCaseStore();
const socketStore = useSocketStore();

const caseId = computed(() => route.params.id);
const entityProfile = computed(() => caseStore.currentCase?.entityProfile);
const documents = ref([]);
const selectedDocumentId = ref(null);
const loading = ref(false);

const selectedDocument = computed(() =>
  documents.value.find((d) => d.id === selectedDocumentId.value)
);

onMounted(async () => {
  loading.value = true;
  documents.value = await api.getDocuments(caseId.value);
  loading.value = false;

  // Listen for real-time updates
  socketStore.on('document:status_changed', onStatusChanged);
  socketStore.on('document:analysis_complete', onAnalysisComplete);
});

onUnmounted(() => {
  socketStore.off('document:status_changed', onStatusChanged);
  socketStore.off('document:analysis_complete', onAnalysisComplete);
});

function onDocumentUploaded(doc) {
  documents.value.unshift(doc);
}

function onDocumentSelect(docId) {
  selectedDocumentId.value = selectedDocumentId.value === docId ? null : docId;
}

function onStatusChanged({ documentId, status }) {
  const doc = documents.value.find((d) => d.id === documentId);
  if (doc) doc.analysisStatus = status;
}

async function onAnalysisComplete({ documentId }) {
  // Refresh the full document record to get extracted data and report
  const updated = await api.getDocument(caseId.value, documentId);
  const idx = documents.value.findIndex((d) => d.id === documentId);
  if (idx >= 0) documents.value[idx] = updated;
}
</script>
```

### File: `frontend/src/components/documents/DocumentUpload.vue`

```vue
<template>
  <div
    class="upload-area"
    :class="{ dragging: isDragging }"
    @dragover.prevent="isDragging = true"
    @dragleave="isDragging = false"
    @drop.prevent="onDrop"
  >
    <div class="upload-content">
      <p>Drag and drop files here, or <label class="browse-link"><input type="file" multiple :accept="acceptedTypes" @change="onFileSelect" hidden />browse</label></p>
      <p class="upload-hint">PDF, images (PNG, JPG), Word documents — max 25 MB</p>
    </div>

    <div v-if="uploads.length > 0" class="upload-progress-list">
      <div v-for="upload in uploads" :key="upload.id" class="upload-item">
        <span class="filename">{{ upload.file.name }}</span>
        <div v-if="upload.status === 'uploading'" class="progress-bar">
          <div class="progress-fill" :style="{ width: upload.progress + '%' }"></div>
        </div>
        <span v-else-if="upload.status === 'done'" class="status-done">Uploaded</span>
        <span v-else-if="upload.status === 'error'" class="status-error">{{ upload.error }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import api from '@/services/api';

const props = defineProps({ caseId: { type: String, required: true } });
const emit = defineEmits(['uploaded']);

const ACCEPTED_MIME_TYPES = [
  'application/pdf',
  'image/png', 'image/jpeg',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];
const MAX_SIZE = 25 * 1024 * 1024; // 25 MB
const acceptedTypes = '.pdf,.png,.jpg,.jpeg,.doc,.docx';

const isDragging = ref(false);
const uploads = ref([]);

function onDrop(event) {
  isDragging.value = false;
  const files = Array.from(event.dataTransfer.files);
  uploadFiles(files);
}

function onFileSelect(event) {
  const files = Array.from(event.target.files);
  uploadFiles(files);
  event.target.value = '';
}

function uploadFiles(files) {
  for (const file of files) {
    if (!ACCEPTED_MIME_TYPES.includes(file.type)) {
      uploads.value.push({ id: crypto.randomUUID(), file, status: 'error', error: 'Unsupported file type', progress: 0 });
      continue;
    }
    if (file.size > MAX_SIZE) {
      uploads.value.push({ id: crypto.randomUUID(), file, status: 'error', error: 'File exceeds 25 MB limit', progress: 0 });
      continue;
    }
    uploadFile(file);
  }
}

async function uploadFile(file) {
  const upload = { id: crypto.randomUUID(), file, status: 'uploading', progress: 0, error: null };
  uploads.value.push(upload);

  try {
    const doc = await api.uploadDocument(props.caseId, file, (progress) => {
      upload.progress = progress;
    });
    upload.status = 'done';
    upload.progress = 100;
    emit('uploaded', doc);
  } catch (err) {
    upload.status = 'error';
    upload.error = err.message || 'Upload failed';
  }
}
</script>
```

### File: `frontend/src/components/documents/DocumentDetail.vue`

```vue
<template>
  <div class="document-detail">
    <div class="detail-header">
      <h3>{{ document.filename }}</h3>
      <span class="assessment-badge" :class="document.report?.assessment">
        {{ assessmentLabel }}
      </span>
    </div>

    <!-- Extracted Data -->
    <section class="extracted-data">
      <h4>Extracted Data</h4>
      <table class="data-table">
        <tr v-for="(value, key) in document.extractedData" :key="key">
          <td class="field-name">{{ formatFieldName(key) }}</td>
          <td class="field-value">{{ formatValue(value) }}</td>
        </tr>
      </table>
    </section>

    <!-- Cross-Reference Results -->
    <DataComparison
      v-if="document.report?.crossReferenceResults"
      :comparisons="document.report.crossReferenceResults"
      :entity-profile="entityProfile"
    />

    <!-- Authenticity Checks -->
    <section v-if="document.report?.authenticityChecks?.length" class="authenticity-checks">
      <h4>Authenticity Checks</h4>
      <div v-for="check in document.report.authenticityChecks" :key="check.check" class="check-item">
        <span class="check-icon" :class="check.status">
          {{ check.status === 'pass' ? '✓' : check.status === 'fail' ? '✗' : '—' }}
        </span>
        <span class="check-details">{{ check.details }}</span>
        <span v-if="check.severity" class="severity-badge" :class="check.severity">{{ check.severity }}</span>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import DataComparison from './DataComparison.vue';

const props = defineProps({
  document: { type: Object, required: true },
  entityProfile: { type: Object, default: null },
});

const assessmentLabel = computed(() => {
  const labels = {
    verified: 'Verified',
    discrepancies_found: 'Discrepancies Found',
    concerns_raised: 'Concerns Raised',
  };
  return labels[props.document.report?.assessment] || props.document.analysisStatus;
});

function formatFieldName(key) {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase());
}

function formatValue(value) {
  if (Array.isArray(value)) return value.join(', ');
  if (value === null || value === undefined) return '—';
  return String(value);
}
</script>
```

### File: `frontend/src/components/documents/DataComparison.vue`

```vue
<template>
  <section class="data-comparison">
    <h4>Cross-Reference: Document vs Registry</h4>
    <table class="comparison-table">
      <thead>
        <tr>
          <th>Field</th>
          <th>Document Data</th>
          <th>Registry Data</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="comp in comparisons" :key="comp.field" :class="rowClass(comp)">
          <td>{{ formatFieldName(comp.field) }}</td>
          <td>{{ formatValue(comp.documentValue) }}</td>
          <td>{{ formatValue(comp.registryValue) }}</td>
          <td>
            <span class="status-icon" :class="comp.status">
              {{ statusIcon(comp.status) }}
            </span>
            <span v-if="comp.severity" class="severity" :class="comp.severity">{{ comp.severity }}</span>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup>
defineProps({
  comparisons: { type: Array, required: true },
  entityProfile: { type: Object, default: null },
});

function rowClass(comp) {
  return {
    'row-match': comp.status === 'match',
    'row-mismatch': comp.status === 'mismatch',
    'row-unavailable': comp.status === 'not_available',
  };
}

function statusIcon(status) {
  return status === 'match' ? '✓' : status === 'mismatch' ? '✗' : '—';
}

function formatFieldName(key) {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase());
}

function formatValue(value) {
  if (Array.isArray(value)) return value.join(', ');
  if (value === null || value === undefined) return '—';
  return String(value);
}
</script>
```

### API Service Methods

```javascript
// frontend/src/services/api.js — additions

/**
 * Get all documents for a case.
 * @param {string} caseId
 * @returns {Promise<Object[]>}
 */
async function getDocuments(caseId) {
  const { data } = await http.get(`/api/v1/cases/${caseId}/documents`);
  return data;
}

/**
 * Get a single document with full analysis report.
 * @param {string} caseId
 * @param {string} documentId
 * @returns {Promise<Object>}
 */
async function getDocument(caseId, documentId) {
  const { data } = await http.get(`/api/v1/cases/${caseId}/documents/${documentId}`);
  return data;
}

/**
 * Upload a document to a case.
 * @param {string} caseId
 * @param {File} file
 * @param {Function} onProgress - Called with percentage (0-100)
 * @returns {Promise<Object>} Created document record
 */
async function uploadDocument(caseId, file, onProgress) {
  const formData = new FormData();
  formData.append('file', file);

  const { data } = await http.post(`/api/v1/cases/${caseId}/documents`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    onUploadProgress: (e) => {
      if (e.total) onProgress(Math.round((e.loaded / e.total) * 100));
    },
  });
  return data;
}
```

### Backend API Endpoint

```javascript
// backend/src/api/routes/cases.js — document upload route

/**
 * POST /api/v1/cases/:id/documents
 *
 * Upload a document to a case. Stores file in MinIO,
 * creates document record, and enqueues Document Analysis Agent.
 */
fastify.post('/:id/documents', {
  schema: {
    params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
  },
  handler: async (request, reply) => {
    const caseId = request.params.id;
    const file = await request.file(); // @fastify/multipart

    // Store in MinIO
    const minioKey = `cases/${caseId}/${Date.now()}-${file.filename}`;
    await documentService.uploadToMinio(minioKey, file.file, file.mimetype);

    // Create document record
    const doc = await documentService.createDocument({
      caseId,
      filename: file.filename,
      mimeType: file.mimetype,
      sizeBytes: file.file.bytesRead,
      minioKey,
      uploadedBy: request.user?.id,
    });

    // Enqueue Document Analysis Agent
    await agentQueue.add('document-analysis', {
      caseId,
      documentId: doc.id,
    });

    // Notify via WebSocket
    socketService.emit(caseId, 'document:uploaded', { documentId: doc.id, filename: file.filename });

    reply.code(201).send(doc);
  },
});

/**
 * GET /api/v1/cases/:id/documents
 */
fastify.get('/:id/documents', {
  handler: async (request, reply) => {
    const docs = await documentService.getDocumentsByCaseId(request.params.id);
    reply.send(docs);
  },
});

/**
 * GET /api/v1/cases/:id/documents/:docId
 */
fastify.get('/:id/documents/:docId', {
  handler: async (request, reply) => {
    const doc = await documentService.getDocument(request.params.docId);
    if (!doc || doc.caseId !== request.params.id) {
      return reply.code(404).send({ error: 'Document not found' });
    }
    reply.send(doc);
  },
});
```

### WebSocket Events

```javascript
// Events emitted during document analysis

// When document is uploaded
socket.emit('document:uploaded', { documentId, filename });

// When analysis status changes
socket.emit('document:status_changed', { documentId, status }); // 'analyzing', 'analyzed', 'failed'

// When analysis is complete (with report summary)
socket.emit('document:analysis_complete', { documentId, assessment, summary });
```

## Acceptance Criteria

- [ ] Documents tab visible in case detail view
- [ ] Drag-and-drop upload area accepts PDF, PNG, JPG, DOC, DOCX
- [ ] File type validation rejects unsupported types with error message
- [ ] File size validation rejects files over 25 MB
- [ ] Multiple file upload supported
- [ ] Upload progress indicator shows percentage per file
- [ ] Document list displays: filename, document type, upload date, analysis status badge, file size
- [ ] Analysis status badges: pending (grey), analyzing (blue/animated), analyzed (green), failed (red)
- [ ] Click document to view: extracted data table, cross-reference results, discrepancy flags, authenticity checks
- [ ] Side-by-side comparison: document data vs registry data with row highlighting (green=match, red=mismatch, grey=N/A)
- [ ] Discrepancy severity shown with color coding (red=critical, amber=warning, grey=info)
- [ ] Overall assessment badge: verified (green), discrepancies_found (amber), concerns_raised (red)
- [ ] Upload calls `POST /api/v1/cases/:id/documents` with multipart form data
- [ ] Upload triggers Document Analysis Agent automatically
- [ ] WebSocket `document:status_changed` updates status badge in real-time
- [ ] WebSocket `document:analysis_complete` refreshes document data without page reload
- [ ] Backend provides `GET /api/v1/cases/:id/documents` and `GET /api/v1/cases/:id/documents/:docId`
- [ ] Browse button works as alternative to drag-and-drop

## Dependencies

- **Depends on**: #53 (Document Analysis Agent — classification and extraction), #54 (Registry cross-referencing — report data shape), #6 (MinIO storage — file storage), #36 (WebSocket events — real-time updates), #41 (Case Detail View — tab integration)
- **Blocks**: None (final story in epic)

## Testing Strategy

1. **Upload success**: Drag valid PDF → progress bar fills → document appears in list with `pending` status
2. **Upload via browse**: Click browse → select file → same result as drag-and-drop
3. **Multiple files**: Drop 3 files → all show progress → all appear in list
4. **Invalid file type**: Drop `.exe` file → error message shown, no upload
5. **File too large**: Drop 30 MB file → error message "File exceeds 25 MB limit"
6. **Status transition**: Upload document → status shows `pending` → WebSocket updates to `analyzing` (badge animates) → `analyzed` (green badge)
7. **Document list rendering**: Case with 10 documents → all render with correct metadata
8. **Document detail — extracted data**: Click analyzed document → extracted data table shows all fields
9. **Document detail — cross-reference**: Click analyzed document → comparison table shows match/mismatch per field
10. **Side-by-side highlighting**: Match row green, mismatch row red, not_available row grey
11. **Assessment badge**: Verified → green; discrepancies_found → amber; concerns_raised → red
12. **Authenticity checks display**: Pass shows checkmark, fail shows X with severity badge, skipped shows dash
13. **WebSocket — status update**: Simulate `document:status_changed` → badge updates without refresh
14. **WebSocket — analysis complete**: Simulate `document:analysis_complete` → detail data refreshes
15. **Empty state**: Case with no documents → "No documents uploaded yet" message shown
16. **Failed analysis**: Document with `failed` status → red badge, detail shows error info

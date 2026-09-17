import { useState, useCallback, useRef } from 'react';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import * as pako from 'pako';
import wasmUrl from 'node-unrar-js/esm/js/unrar.wasm?url';

// Types
interface FileEntry {
  name: string;
  size: number;
  type: string;
  data: Uint8Array | ArrayBuffer | Blob;
  isDirectory: boolean;
}

interface ExtractedArchive {
  name: string;
  files: FileEntry[];
  totalSize: number;
}

interface CompressOptions {
  format: 'zip';
  level: 'store' | 'deflate';
}

// Utility functions
function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function getFileExtension(filename: string): string {
  const parts = filename.toLowerCase().split('.');
  if (parts.length >= 3 && parts[parts.length - 1] === 'gz' && parts[parts.length - 2] === 'tar') {
    return 'tar.gz';
  }
  return parts.pop() || '';
}

function getFileIcon(filename: string, isDirectory: boolean): string {
  if (isDirectory) return '📁';
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const icons: Record<string, string> = {
    pdf: '📄',
    doc: '📝', docx: '📝',
    xls: '📊', xlsx: '📊',
    ppt: '📽️', pptx: '📽️',
    jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️', bmp: '🖼️',
    mp3: '🎵', wav: '🎵', flac: '🎵', ogg: '🎵',
    mp4: '🎬', avi: '🎬', mkv: '🎬', mov: '🎬', webm: '🎬',
    zip: '🗜️', rar: '🗜️', '7z': '🗜️', tar: '🗜️', gz: '🗜️',
    js: '💻', ts: '💻', py: '💻', java: '💻', cpp: '💻', c: '💻', html: '💻', css: '💻',
    txt: '📃', md: '📃', json: '📃', xml: '📃', csv: '📃',
  };
  return icons[ext] || '📄';
}

// Main App Component
export default function App() {
  const [activeTab, setActiveTab] = useState<'extract' | 'compress'>('extract');
  const [isDragging, setIsDragging] = useState(false);
  const [extractedArchive, setExtractedArchive] = useState<ExtractedArchive | null>(null);
  const [compressFiles, setCompressFiles] = useState<File[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notification, setNotification] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [compressionLevel, setCompressionLevel] = useState<'store' | 'deflate'>('deflate');
  
  const extractInputRef = useRef<HTMLInputElement>(null);
  const compressInputRef = useRef<HTMLInputElement>(null);

  const showNotification = (message: string, type: 'success' | 'error' | 'info') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 4000);
  };

  // Extract functions
  const extractZip = async (file: File): Promise<ExtractedArchive> => {
    const zip = new JSZip();
    const contents = await zip.loadAsync(file);
    const files: FileEntry[] = [];
    
    const entries = Object.entries(contents.files);
    let processed = 0;
    
    for (const [name, zipEntry] of entries) {
      if (!zipEntry.dir) {
        const data = await zipEntry.async('uint8array');
        files.push({
          name,
          size: data.length,
          type: '',
          data,
          isDirectory: false,
        });
      } else {
        files.push({
          name,
          size: 0,
          type: '',
          data: new Uint8Array(0),
          isDirectory: true,
        });
      }
      processed++;
      setProgress(Math.round((processed / entries.length) * 100));
    }
    
    const totalSize = files.reduce((acc, f) => acc + f.size, 0);
    return { name: file.name, files, totalSize };
  };

  const extractGzip = async (file: File): Promise<ExtractedArchive> => {
    const arrayBuffer = await file.arrayBuffer();
    const decompressed = pako.inflate(new Uint8Array(arrayBuffer));
    const name = file.name.replace(/\.gz$/i, '').replace(/\.tgz$/i, '.tar');
    
    const files: FileEntry[] = [{
      name: name || 'extracted_file',
      size: decompressed.length,
      type: '',
      data: decompressed,
      isDirectory: false,
    }];
    
    return { name: file.name, files, totalSize: decompressed.length };
  };

  const extractTar = async (file: File): Promise<ExtractedArchive> => {
    const arrayBuffer = await file.arrayBuffer();
    let data = new Uint8Array(arrayBuffer);
    
    // If it's a .tar.gz or .tgz, decompress first
    const name = file.name.toLowerCase();
    if (name.endsWith('.tar.gz') || name.endsWith('.tgz')) {
      data = pako.inflate(data);
    }
    
    const files: FileEntry[] = [];
    let offset = 0;
    
    while (offset < data.length - 512) {
      // Read header
      const header = data.slice(offset, offset + 512);
      
      // Check if it's all zeros (end of archive)
      if (header.every(b => b === 0)) break;
      
      // Get filename (first 100 bytes)
      let filename = '';
      for (let i = 0; i < 100; i++) {
        if (header[i] === 0) break;
        filename += String.fromCharCode(header[i]);
      }
      
      if (!filename.trim()) {
        offset += 512;
        continue;
      }
      
      // Get file size (bytes 124-135, octal)
      let sizeStr = '';
      for (let i = 124; i < 136; i++) {
        if (header[i] === 0) break;
        sizeStr += String.fromCharCode(header[i]);
      }
      const fileSize = parseInt(sizeStr.trim(), 8) || 0;
      
      // Get file type (byte 156)
      const typeFlag = String.fromCharCode(header[156]);
      const isDirectory = typeFlag === '5';
      
      offset += 512;
      
      if (!isDirectory && fileSize > 0) {
        const fileData = data.slice(offset, offset + fileSize);
        files.push({
          name: filename,
          size: fileSize,
          type: '',
          data: fileData,
          isDirectory: false,
        });
        
        // Move to next 512-byte boundary
        offset += Math.ceil(fileSize / 512) * 512;
      } else {
        files.push({
          name: filename,
          size: 0,
          type: '',
          data: new Uint8Array(0),
          isDirectory: isDirectory,
        });
      }
    }
    
    const totalSize = files.reduce((acc, f) => acc + f.size, 0);
    return { name: file.name, files, totalSize };
  };

  const extractRar = async (file: File): Promise<ExtractedArchive> => {
    try {
      // Dynamic import to avoid bundling Node.js modules in browser
      const { createExtractorFromData } = await import('node-unrar-js/esm');
      
      const arrayBuffer = await file.arrayBuffer();
      
      // Load WASM binary using the imported URL
      const wasmBinary = await fetch(wasmUrl).then(r => r.arrayBuffer());
      
      const extractor = await createExtractorFromData({ 
        data: arrayBuffer,
        wasmBinary 
      });
      
      const list = extractor.getFileList();
      const fileHeaders = [...list.fileHeaders];
      
      const extracted = extractor.extract();
      const extractedFiles = [...extracted.files];
      
      const files: FileEntry[] = [];
      
      for (let i = 0; i < extractedFiles.length; i++) {
        const arcFile = extractedFiles[i];
        const header = arcFile.fileHeader;
        
        if (header.flags.directory) {
          files.push({
            name: header.name,
            size: 0,
            type: '',
            data: new Uint8Array(0),
            isDirectory: true,
          });
        } else {
          files.push({
            name: header.name,
            size: header.unpSize,
            type: '',
            data: arcFile.extraction || new Uint8Array(0),
            isDirectory: false,
          });
        }
        
        setProgress(Math.round(((i + 1) / extractedFiles.length) * 100));
      }
      
      const totalSize = files.reduce((acc, f) => acc + f.size, 0);
      return { name: file.name, files, totalSize };
    } catch (err: any) {
      console.error('RAR extraction error:', err);
      throw new Error('Não foi possível extrair o arquivo RAR. O arquivo pode estar corrompido, protegido por senha, ou em formato não suportado.');
    }
  };

  const handleExtract = async (file: File) => {
    setIsLoading(true);
    setError(null);
    setProgress(0);
    setSelectedFiles(new Set());
    
    try {
      const ext = getFileExtension(file.name);
      let archive: ExtractedArchive;
      
      switch (ext) {
        case 'zip':
          archive = await extractZip(file);
          break;
        case 'rar':
          archive = await extractRar(file);
          break;
        case 'gz':
        case 'tgz':
        case 'tar.gz':
          archive = await extractGzip(file);
          break;
        case 'tar':
          archive = await extractTar(file);
          break;
        default:
          throw new Error(`Formato .${ext} não suportado. Formatos aceitos: .zip, .rar, .tar, .gz, .tgz`);
      }
      
      setExtractedArchive(archive);
      showNotification(`Arquivo "${file.name}" extraído com sucesso! ${archive.files.filter(f => !f.isDirectory).length} arquivos encontrados.`, 'success');
    } catch (err: any) {
      const message = err.message || 'Erro ao extrair arquivo';
      setError(message);
      showNotification(message, 'error');
    } finally {
      setIsLoading(false);
      setProgress(0);
    }
  };

  // Compress functions
  const handleCompress = async (options: CompressOptions) => {
    if (compressFiles.length === 0) {
      showNotification('Adicione arquivos para compactar.', 'error');
      return;
    }
    
    setIsLoading(true);
    setError(null);
    setProgress(0);
    
    try {
      if (options.format === 'zip') {
        const zip = new JSZip();
        
        for (let i = 0; i < compressFiles.length; i++) {
          const file = compressFiles[i];
          const compressionMethod = options.level === 'deflate' ? 'DEFLATE' : 'STORE';
          
          zip.file(file.name, file, {
            compression: compressionMethod as any,
            compressionOptions: options.level === 'deflate' ? { level: 9 } : undefined,
          });
          
          setProgress(Math.round(((i + 1) / compressFiles.length) * 50));
        }
        
        const blob = await zip.generateAsync(
          { type: 'blob', compression: options.level === 'deflate' ? 'DEFLATE' : 'STORE' },
          (metadata) => {
            setProgress(50 + Math.round(metadata.percent / 2));
          }
        );
        
        saveAs(blob, 'arquivo.zip');
        showNotification('Arquivo ZIP criado com sucesso!', 'success');
      }
    } catch (err: any) {
      const message = err.message || 'Erro ao compactar arquivos';
      setError(message);
      showNotification(message, 'error');
    } finally {
      setIsLoading(false);
      setProgress(0);
    }
  };

  // Download single file from extracted archive
  const downloadFile = (file: FileEntry) => {
    if (file.isDirectory) return;
    const blob = new Blob([file.data as BlobPart]);
    const fileName = file.name.split('/').pop() || file.name;
    saveAs(blob, fileName);
  };

  // Download all selected files as zip
  const downloadAllAsZip = async () => {
    if (!extractedArchive) return;
    
    setIsLoading(true);
    try {
      const zip = new JSZip();
      const filesToDownload = selectedFiles.size > 0 
        ? extractedArchive.files.filter(f => selectedFiles.has(f.name) && !f.isDirectory)
        : extractedArchive.files.filter(f => !f.isDirectory);
      
      for (const file of filesToDownload) {
        zip.file(file.name, file.data as any);
      }
      
      const blob = await zip.generateAsync({ type: 'blob' });
      const archiveName = extractedArchive.name.replace(/\.[^.]+$/, '');
      saveAs(blob, `${archiveName}_extracted.zip`);
      showNotification('Download iniciado!', 'success');
    } catch (err: any) {
      showNotification('Erro ao criar arquivo ZIP', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  // Drag and drop handlers
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    const files = Array.from(e.dataTransfer.files);
    if (activeTab === 'extract' && files.length > 0) {
      handleExtract(files[0]);
    } else if (activeTab === 'compress') {
      setCompressFiles(prev => [...prev, ...files]);
    }
  }, [activeTab]);

  const toggleFileSelection = (fileName: string) => {
    setSelectedFiles(prev => {
      const next = new Set(prev);
      if (next.has(fileName)) {
        next.delete(fileName);
      } else {
        next.add(fileName);
      }
      return next;
    });
  };

  const selectAllFiles = () => {
    if (!extractedArchive) return;
    const allFileNames = extractedArchive.files.filter(f => !f.isDirectory).map(f => f.name);
    if (selectedFiles.size === allFileNames.length) {
      setSelectedFiles(new Set());
    } else {
      setSelectedFiles(new Set(allFileNames));
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-indigo-950">
      {/* Notification */}
      {notification && (
        <div className={`fixed top-4 right-4 z-50 animate-slide-down px-6 py-3 rounded-lg shadow-2xl flex items-center gap-3 max-w-md ${
          notification.type === 'success' ? 'bg-emerald-500/90 backdrop-blur-sm' :
          notification.type === 'error' ? 'bg-red-500/90 backdrop-blur-sm' :
          'bg-blue-500/90 backdrop-blur-sm'
        }`}>
          <span className="text-xl">
            {notification.type === 'success' ? '✅' : notification.type === 'error' ? '❌' : 'ℹ️'}
          </span>
          <span className="text-white font-medium text-sm">{notification.message}</span>
        </div>
      )}

      {/* Header */}
      <header className="border-b border-slate-700/50 backdrop-blur-sm bg-slate-900/50 sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/30">
              <span className="text-xl">🗜️</span>
            </div>
            <div>
              <h1 className="text-xl font-bold bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">
                My Zipper
              </h1>
              <p className="text-xs text-slate-400">Compactador & Descompactador</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span className="hidden sm:inline px-2 py-1 bg-slate-800 rounded-md border border-slate-700">ZIP</span>
            <span className="hidden sm:inline px-2 py-1 bg-slate-800 rounded-md border border-slate-700">RAR</span>
            <span className="hidden sm:inline px-2 py-1 bg-slate-800 rounded-md border border-slate-700">TAR</span>
            <span className="hidden sm:inline px-2 py-1 bg-slate-800 rounded-md border border-slate-700">GZ</span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-4 py-8">
        {/* Tab Navigation */}
        <div className="flex gap-2 mb-8">
          <button
            onClick={() => { setActiveTab('extract'); setError(null); }}
            className={`px-6 py-3 rounded-xl font-semibold transition-all duration-300 flex items-center gap-2 ${
              activeTab === 'extract'
                ? 'bg-gradient-to-r from-indigo-500 to-purple-600 text-white shadow-lg shadow-indigo-500/30'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700 border border-slate-700'
            }`}
          >
            <span>📂</span>
            <span>Descompactar</span>
          </button>
          <button
            onClick={() => { setActiveTab('compress'); setError(null); }}
            className={`px-6 py-3 rounded-xl font-semibold transition-all duration-300 flex items-center gap-2 ${
              activeTab === 'compress'
                ? 'bg-gradient-to-r from-indigo-500 to-purple-600 text-white shadow-lg shadow-indigo-500/30'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700 border border-slate-700'
            }`}
          >
            <span>📦</span>
            <span>Compactar</span>
          </button>
        </div>

        {/* Extract Tab */}
        {activeTab === 'extract' && (
          <div className="animate-fade-in space-y-6">
            {/* Drop Zone */}
            <div
              className={`drop-zone border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-all duration-300 ${
                isDragging
                  ? 'border-indigo-400 bg-indigo-500/10 scale-[1.02]'
                  : 'border-slate-600 bg-slate-800/50 hover:border-indigo-500/50 hover:bg-slate-800'
              }`}
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              onClick={() => extractInputRef.current?.click()}
            >
              <input
                ref={extractInputRef}
                type="file"
                accept=".zip,.rar,.tar,.gz,.tgz"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleExtract(file);
                  e.target.value = '';
                }}
              />
              <div className="text-6xl mb-4">📂</div>
              <h3 className="text-xl font-semibold text-white mb-2">
                Arraste seu arquivo aqui
              </h3>
              <p className="text-slate-400 mb-4">
                ou clique para selecionar
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {['.zip', '.rar', '.tar', '.gz', '.tgz'].map(ext => (
                  <span key={ext} className="px-3 py-1 bg-slate-700/50 rounded-full text-xs text-slate-300 border border-slate-600">
                    {ext}
                  </span>
                ))}
              </div>
            </div>

            {/* Loading */}
            {isLoading && (
              <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-5 h-5 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin"></div>
                  <span className="text-slate-300">Processando arquivo...</span>
                </div>
                <div className="w-full bg-slate-700 rounded-full h-2">
                  <div
                    className="bg-gradient-to-r from-indigo-500 to-purple-500 h-2 rounded-full transition-all duration-300 progress-bar"
                    style={{ width: `${progress}%` }}
                  ></div>
                </div>
                <p className="text-xs text-slate-400 mt-2">{progress}% concluído</p>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 flex items-start gap-3">
                <span className="text-xl">⚠️</span>
                <div>
                  <p className="text-red-400 font-medium">Erro ao processar</p>
                  <p className="text-red-300/80 text-sm mt-1">{error}</p>
                </div>
              </div>
            )}

            {/* Extracted Files */}
            {extractedArchive && (
              <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden animate-fade-in">
                <div className="p-4 border-b border-slate-700 flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <h3 className="font-semibold text-white flex items-center gap-2">
                      <span>📋</span>
                      Arquivos extraídos de: <span className="text-indigo-400">{extractedArchive.name}</span>
                    </h3>
                    <p className="text-sm text-slate-400 mt-1">
                      {extractedArchive.files.filter(f => !f.isDirectory).length} arquivos • {formatFileSize(extractedArchive.totalSize)} total
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={selectAllFiles}
                      className="px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm text-slate-300 transition-colors"
                    >
                      {selectedFiles.size === extractedArchive.files.filter(f => !f.isDirectory).length ? '☐ Desmarcar' : '☑ Selecionar'} todos
                    </button>
                    <button
                      onClick={downloadAllAsZip}
                      className="px-4 py-2 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 rounded-lg text-sm text-white font-medium transition-all shadow-lg shadow-indigo-500/20"
                    >
                      ⬇️ Baixar {selectedFiles.size > 0 ? `(${selectedFiles.size})` : 'todos'}
                    </button>
                  </div>
                </div>
                <div className="max-h-96 overflow-y-auto">
                  {extractedArchive.files.map((file, index) => (
                    <div
                      key={index}
                      className={`flex items-center gap-3 px-4 py-3 border-b border-slate-700/50 hover:bg-slate-700/30 transition-colors ${
                        selectedFiles.has(file.name) ? 'bg-indigo-500/10' : ''
                      }`}
                    >
                      {!file.isDirectory && (
                        <input
                          type="checkbox"
                          checked={selectedFiles.has(file.name)}
                          onChange={() => toggleFileSelection(file.name)}
                          className="w-4 h-4 rounded border-slate-500 text-indigo-500 focus:ring-indigo-500 bg-slate-700"
                        />
                      )}
                      <span className="text-lg">{getFileIcon(file.name, file.isDirectory)}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-white truncate">{file.name}</p>
                        {!file.isDirectory && (
                          <p className="text-xs text-slate-400">{formatFileSize(file.size)}</p>
                        )}
                      </div>
                      {!file.isDirectory && (
                        <button
                          onClick={(e) => { e.stopPropagation(); downloadFile(file); }}
                          className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded-lg text-xs text-slate-300 transition-colors flex items-center gap-1"
                        >
                          <span>⬇️</span> Baixar
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Compress Tab */}
        {activeTab === 'compress' && (
          <div className="animate-fade-in space-y-6">
            {/* Drop Zone */}
            <div
              className={`drop-zone border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-all duration-300 ${
                isDragging
                  ? 'border-indigo-400 bg-indigo-500/10 scale-[1.02]'
                  : 'border-slate-600 bg-slate-800/50 hover:border-indigo-500/50 hover:bg-slate-800'
              }`}
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              onClick={() => compressInputRef.current?.click()}
            >
              <input
                ref={compressInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  setCompressFiles(prev => [...prev, ...files]);
                  e.target.value = '';
                }}
              />
              <div className="text-6xl mb-4">📦</div>
              <h3 className="text-xl font-semibold text-white mb-2">
                Arraste seus arquivos aqui
              </h3>
              <p className="text-slate-400 mb-4">
                ou clique para selecionar (múltiplos arquivos)
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                <span className="px-3 py-1 bg-slate-700/50 rounded-full text-xs text-slate-300 border border-slate-600">
                  Qualquer tipo de arquivo
                </span>
              </div>
            </div>

            {/* File List */}
            {compressFiles.length > 0 && (
              <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden animate-fade-in">
                <div className="p-4 border-b border-slate-700 flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold text-white flex items-center gap-2">
                      <span>📋</span>
                      Arquivos para compactar
                    </h3>
                    <p className="text-sm text-slate-400 mt-1">
                      {compressFiles.length} arquivos • {formatFileSize(compressFiles.reduce((acc, f) => acc + f.size, 0))} total
                    </p>
                  </div>
                  <button
                    onClick={() => setCompressFiles([])}
                    className="px-3 py-2 bg-red-500/20 hover:bg-red-500/30 rounded-lg text-sm text-red-400 transition-colors"
                  >
                    🗑️ Limpar
                  </button>
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {compressFiles.map((file, index) => (
                    <div
                      key={index}
                      className="flex items-center gap-3 px-4 py-3 border-b border-slate-700/50 hover:bg-slate-700/30 transition-colors"
                    >
                      <span className="text-lg">{getFileIcon(file.name, false)}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-white truncate">{file.name}</p>
                        <p className="text-xs text-slate-400">{formatFileSize(file.size)}</p>
                      </div>
                      <button
                        onClick={() => setCompressFiles(prev => prev.filter((_, i) => i !== index))}
                        className="px-2 py-1 text-slate-400 hover:text-red-400 transition-colors"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Compression Options */}
            {compressFiles.length > 0 && (
              <div className="bg-slate-800 rounded-xl border border-slate-700 p-6 animate-fade-in">
                <h3 className="font-semibold text-white mb-4 flex items-center gap-2">
                  <span>⚙️</span>
                  Opções de Compactação
                </h3>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Format */}
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">Formato</label>
                    <div className="flex gap-2">
                      <button className="flex-1 px-4 py-3 bg-indigo-500/20 border-2 border-indigo-500 rounded-xl text-indigo-300 font-medium flex items-center justify-center gap-2">
                        <span>🗜️</span> ZIP
                      </button>
                      <button className="flex-1 px-4 py-3 bg-slate-700/50 border-2 border-slate-600 rounded-xl text-slate-500 font-medium flex items-center justify-center gap-2 cursor-not-allowed" title="Formato RAR é proprietário e não pode ser criado no navegador">
                        <span>🗜️</span> RAR
                        <span className="text-xs bg-slate-600 px-1.5 py-0.5 rounded">N/A</span>
                      </button>
                    </div>
                    <p className="text-xs text-slate-500 mt-2">
                      * Formato RAR é proprietário e não pode ser criado no navegador
                    </p>
                  </div>

                  {/* Compression Level */}
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">Nível de Compressão</label>
                    <div className="flex gap-2">
                      <label className="flex-1 cursor-pointer">
                        <input 
                          type="radio" 
                          name="compression" 
                          value="deflate" 
                          checked={compressionLevel === 'deflate'}
                          onChange={() => setCompressionLevel('deflate')}
                          className="hidden peer" 
                        />
                        <div className="px-4 py-3 bg-slate-700/50 border-2 border-slate-600 peer-checked:border-indigo-500 peer-checked:bg-indigo-500/20 rounded-xl text-center text-slate-300 peer-checked:text-indigo-300 font-medium transition-all">
                          🔥 Máxima
                        </div>
                      </label>
                      <label className="flex-1 cursor-pointer">
                        <input 
                          type="radio" 
                          name="compression" 
                          value="store" 
                          checked={compressionLevel === 'store'}
                          onChange={() => setCompressionLevel('store')}
                          className="hidden peer" 
                        />
                        <div className="px-4 py-3 bg-slate-700/50 border-2 border-slate-600 peer-checked:border-indigo-500 peer-checked:bg-indigo-500/20 rounded-xl text-center text-slate-300 peer-checked:text-indigo-300 font-medium transition-all">
                          ⚡ Apenas Armazenar
                        </div>
                      </label>
                    </div>
                  </div>
                </div>

                {/* Compress Button */}
                <div className="mt-6 flex justify-center">
                  <button
                    onClick={() => handleCompress({ format: 'zip', level: compressionLevel })}
                    disabled={isLoading}
                    className="px-8 py-4 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 disabled:from-slate-600 disabled:to-slate-700 rounded-xl text-white font-bold text-lg transition-all shadow-lg shadow-indigo-500/30 hover:shadow-indigo-500/50 disabled:shadow-none flex items-center gap-3"
                  >
                    {isLoading ? (
                      <>
                        <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                        Compactando...
                      </>
                    ) : (
                      <>
                        <span>📦</span>
                        Compactar em ZIP
                      </>
                    )}
                  </button>
                </div>

                {/* Progress */}
                {isLoading && (
                  <div className="mt-4">
                    <div className="w-full bg-slate-700 rounded-full h-2">
                      <div
                        className="bg-gradient-to-r from-indigo-500 to-purple-500 h-2 rounded-full transition-all duration-300"
                        style={{ width: `${progress}%` }}
                      ></div>
                    </div>
                    <p className="text-xs text-slate-400 mt-2 text-center">{progress}% concluído</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Info Section */}
        <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-slate-800/50 rounded-xl p-5 border border-slate-700/50">
            <div className="text-2xl mb-2">🔒</div>
            <h4 className="font-semibold text-white mb-1">100% Local</h4>
            <p className="text-sm text-slate-400">
              Todos os arquivos são processados no seu navegador. Nenhum dado é enviado para servidores.
            </p>
          </div>
          <div className="bg-slate-800/50 rounded-xl p-5 border border-slate-700/50">
            <div className="text-2xl mb-2">⚡</div>
            <h4 className="font-semibold text-white mb-1">Rápido & Eficiente</h4>
            <p className="text-sm text-slate-400">
              Processamento rápido usando WebAssembly e algoritmos otimizados de compressão.
            </p>
          </div>
          <div className="bg-slate-800/50 rounded-xl p-5 border border-slate-700/50">
            <div className="text-2xl mb-2">📁</div>
            <h4 className="font-semibold text-white mb-1">Múltiplos Formatos</h4>
            <p className="text-sm text-slate-400">
              Suporte para ZIP, RAR, TAR, GZ e mais. Compacte e descompacte facilmente.
            </p>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-700/50 mt-12">
        <div className="max-w-6xl mx-auto px-4 py-6 text-center text-sm text-slate-500">
          <p>My Zipper © 2025 — Compactador e Descompactador de Arquivos</p>
          <p className="mt-1 text-xs">Processamento 100% local no seu navegador. Seus arquivos nunca saem do seu dispositivo.</p>
        </div>
      </footer>
    </div>
  );
}

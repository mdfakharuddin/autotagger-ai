// File System Access API service for working with local folders

export interface FileSystemFileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
}

export interface FileSystemDirectoryHandle {
  kind: 'directory';
  name: string;
  values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle>;
  getFileHandle(name: string): Promise<FileSystemFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

export class FileSystemService {
  private directoryHandle: FileSystemDirectoryHandle | null = null;

  async selectFolder(): Promise<FileSystemDirectoryHandle | null> {
    if (!('showDirectoryPicker' in window)) {
      throw new Error('File System Access API is not supported in this browser. Please use Chrome, Edge, or Opera.');
    }

    try {
      const handle = await (window as any).showDirectoryPicker({
        mode: 'readwrite'
      });
      this.directoryHandle = handle;
      return handle;
    } catch (error: any) {
      if (error.name === 'AbortError') {
        return null; // User cancelled
      }
      throw error;
    }
  }

  async getFilesFromFolder(
    directoryHandle: FileSystemDirectoryHandle,
    extensions: string[] = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'mov', 'avi', 'webm']
  ): Promise<Array<{ handle: FileSystemFileHandle; name: string; path: string }>> {
    const files: Array<{ handle: FileSystemFileHandle; name: string; path: string }> = [];
    
    const scanDirectory = async (
      dir: FileSystemDirectoryHandle,
      path: string = ''
    ): Promise<void> => {
      for await (const entry of dir.values()) {
        if (entry.kind === 'file') {
          const ext = entry.name.split('.').pop()?.toLowerCase();
          if (ext && extensions.includes(ext)) {
            files.push({
              handle: entry as FileSystemFileHandle,
              name: entry.name,
              path: path ? `${path}/${entry.name}` : entry.name
            });
          }
        } else if (entry.kind === 'directory') {
          await scanDirectory(entry as FileSystemDirectoryHandle, path ? `${path}/${entry.name}` : entry.name);
        }
      }
    };

    await scanDirectory(directoryHandle);
    return files;
  }

  async readFileForPreview(handle: FileSystemFileHandle): Promise<{ file: File; previewUrl: string }> {
    const file = await handle.getFile();
    const previewUrl = file.type.startsWith('image/') 
      ? URL.createObjectURL(file)
      : '';
    return { file, previewUrl };
  }

  async readFileForProcessing(handle: FileSystemFileHandle): Promise<File> {
    return await handle.getFile();
  }

  async saveMetadataFile(
    directoryHandle: FileSystemDirectoryHandle,
    filename: string,
    metadata: any
  ): Promise<void> {
    // Find the directory containing the file (handle nested paths)
    const pathParts = filename.includes('/') ? filename.split('/') : [filename];
    const actualFilename = pathParts[pathParts.length - 1];
    let targetDir = directoryHandle;
    
    // Navigate to subdirectory if needed
    if (pathParts.length > 1) {
      const dirPath = pathParts.slice(0, -1);
      for (const dirName of dirPath) {
        targetDir = await (targetDir as any).getDirectoryHandle(dirName);
      }
    }
    
    const metadataFilename = `${actualFilename}.pitagger.json`;
    const fileHandle = await (targetDir as any).getFileHandle(metadataFilename, { create: true });
    const writable = await (fileHandle as any).createWritable();
    await writable.write(JSON.stringify(metadata, null, 2));
    await writable.close();
  }

  async renameFile(
    directoryHandle: FileSystemDirectoryHandle,
    oldName: string,
    newName: string
  ): Promise<void> {
    try {
      const oldHandle = await (directoryHandle as any).getFileHandle(oldName);
      const newHandle = await (directoryHandle as any).getFileHandle(newName, { create: true });
      
      // Copy file content
      const file = await oldHandle.getFile();
      const writable = await (newHandle as any).createWritable();
      await writable.write(await file.arrayBuffer());
      await writable.close();
      
      // Delete old file
      await (directoryHandle as any).removeEntry(oldName);
      
      // Also rename metadata file if it exists
      const oldMetadataName = `${oldName}.pitagger.json`;
      const newMetadataName = `${newName}.pitagger.json`;
      try {
        const oldMetadataHandle = await (directoryHandle as any).getFileHandle(oldMetadataName);
        const newMetadataHandle = await (directoryHandle as any).getFileHandle(newMetadataName, { create: true });
        const metadataFile = await oldMetadataHandle.getFile();
        const writable = await (newMetadataHandle as any).createWritable();
        await writable.write(await metadataFile.arrayBuffer());
        await writable.close();
        await (directoryHandle as any).removeEntry(oldMetadataName);
      } catch (e) {
        // Metadata file doesn't exist, that's okay
      }
    } catch (error) {
      console.error('Error renaming file:', error);
      throw error;
    }
  }

  getCurrentDirectory(): FileSystemDirectoryHandle | null {
    return this.directoryHandle;
  }

  setDirectory(handle: FileSystemDirectoryHandle | null) {
    this.directoryHandle = handle;
  }
}

export const fileSystemService = new FileSystemService();


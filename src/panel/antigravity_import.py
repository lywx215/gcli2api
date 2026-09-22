"""Validate the whole Antigravity import before issuing any credential writes."""
import asyncio
from dataclasses import dataclass
import json
import struct
from pathlib import PurePosixPath
from tempfile import SpooledTemporaryFile
import zipfile
import zlib

from fastapi import HTTPException
from fastapi.responses import JSONResponse
from src.antigravity_import_limits import ImportLimits, import_slot, limit_exceeded
from src.credential_manager import CredentialStorageError


@dataclass
class PreparedImport:
    data: object
    items: list

    def close(self):
        self.data.close()


def _directory_count(source, remaining):
    """Count central-directory records before ZipFile allocates entry objects.

    Accept ordinary ZIP archives (including ZIP64 local file headers). ZIP64
    directory extensions are reported unsupported instead of allocating an
    unbounded directory from attacker-controlled metadata.
    """
    source.seek(0, 2)
    end = source.tell()
    source.seek(max(0, end - 65557))
    tail = source.read(65557)
    index = tail.rfind(b'PK\x05\x06')
    if index < 0 or len(tail) - index < 22:
        raise zipfile.BadZipFile()
    record = struct.unpack_from('<4s4H2LH', tail, index)
    _, disk, directory_disk, local_count, count, size, offset, comment = record
    if index + 22 + comment != len(tail):
        raise zipfile.BadZipFile()
    if disk or directory_disk or count != local_count or count == 65535 or size == 0xffffffff or offset == 0xffffffff:
        raise NotImplementedError('Unsupported ZIP directory')
    if count > remaining:
        raise limit_exceeded()
    directory_end = end - len(tail) + index
    directory_start = directory_end - size
    if directory_start < 0:
        raise zipfile.BadZipFile()
    source.seek(directory_start)
    actual = 0
    while source.tell() < directory_end:
        header = source.read(46)
        if len(header) != 46 or header[:4] != b'PK\x01\x02':
            raise zipfile.BadZipFile()
        actual += 1
        if actual > remaining:
            raise limit_exceeded()
        name_size, extra_size, comment_size = struct.unpack_from('<3H', header, 28)
        source.seek(name_size + extra_size + comment_size, 1)
        if source.tell() > directory_end:
            raise zipfile.BadZipFile()
    if actual != count:
        raise zipfile.BadZipFile()
    source.seek(0)
    return actual


def _prepare(files, limits):
    """Runs in a worker thread; spool validated bytes instead of decoded objects."""
    prepared = PreparedImport(SpooledTemporaryFile(max_size=1024*1024), [])
    names = set()
    total = 0
    entries = 0

    def name_of(name):
        return PurePosixPath((name or '').replace('\\', '/')).name

    def error(filename, code, message):
        prepared.items.append({'filename':filename, 'status':'error', 'error_code':code, 'message':message})

    def read_json(source, source_name):
        nonlocal total
        filename = name_of(source_name)
        duplicate = filename in names
        names.add(filename)
        # Even invalid/duplicate documents count toward actual decompressed limits.
        body = bytearray()
        while True:
            chunk = source.read(min(65536, limits.json_bytes - len(body) + 1))
            if not chunk:
                break
            total += len(chunk)
            body.extend(chunk)
            if len(body) > limits.json_bytes or total > limits.expanded_bytes:
                raise limit_exceeded()
        if not filename or duplicate:
            error(filename, 'duplicate_filename' if duplicate else 'invalid_filename', '同批文件名重复' if duplicate else '文件名无效')
            return
        try:
            text = body.decode('utf-8')
            document = json.loads(text)
            if not isinstance(document, dict):
                raise ValueError
        except UnicodeDecodeError:
            error(filename, 'invalid_encoding', '文件必须使用 UTF-8 编码')
            return
        except (ValueError, RecursionError):
            error(filename, 'invalid_json', '凭证必须为有效 JSON 对象')
            return
        position = prepared.data.tell()
        prepared.data.write(body)
        prepared.items.append({'filename':filename, 'position':position, 'length':len(body)})

    try:
        if not files:
            raise HTTPException(status_code=400, detail='请选择要上传的文件')
        if len(files) > limits.files:
            raise limit_exceeded()
        uploaded = 0
        for upload in files:
            upload.file.seek(0, 2)
            uploaded += upload.file.tell()
            upload.file.seek(0)
        if uploaded > limits.request_bytes:
            raise limit_exceeded()
        for upload in files:
            filename = name_of(upload.filename)
            suffix = filename.lower()
            if suffix.endswith('.json'):
                read_json(upload.file, filename)
            elif suffix.endswith('.zip'):
                try:
                    entries += _directory_count(upload.file, limits.zip_entries - entries)
                    with zipfile.ZipFile(upload.file) as archive:
                        infos = archive.infolist()
                        if entries > limits.zip_entries:
                            raise limit_exceeded()
                        candidates = [entry for entry in infos if not entry.is_dir() and entry.filename.lower().endswith('.json')]
                        if any(entry.file_size > limits.json_bytes for entry in candidates):
                            raise limit_exceeded()
                        if total + sum(entry.file_size for entry in candidates) > limits.expanded_bytes:
                            raise limit_exceeded()
                        if not infos:
                            error(filename, 'empty_zip', 'ZIP 文件为空')
                        for entry in infos:
                            if entry.is_dir():
                                continue
                            if not entry.filename.lower().endswith('.json'):
                                error(name_of(entry.filename), 'unsupported_entry', '仅导入 JSON 文件，不递归解压')
                                continue
                            try:
                                with archive.open(entry) as source:
                                    read_json(source, entry.filename)
                            except HTTPException:
                                raise
                            except (RuntimeError, NotImplementedError, zipfile.BadZipFile, EOFError, OSError, zlib.error):
                                names.add(name_of(entry.filename))
                                error(name_of(entry.filename), 'unreadable_zip_entry', '压缩条目无法读取')
                except HTTPException:
                    raise
                except NotImplementedError:
                    error(filename, 'unsupported_zip', '不支持此 ZIP 目录格式')
                except (zipfile.BadZipFile, EOFError, OSError, UnicodeError):
                    error(filename, 'invalid_zip', 'ZIP 格式无效')
            else:
                error(filename, 'unsupported_file', '仅支持 JSON 和 ZIP 文件')
        return prepared
    except BaseException:
        prepared.close()
        raise


async def _upload_antigravity_files(files, manager):
    async with import_slot():
        prepared = None
        task = asyncio.create_task(asyncio.to_thread(_prepare, files, ImportLimits.load()))
        try:
            try:
                prepared = await asyncio.shield(task)
            except asyncio.CancelledError:
                # A thread cannot be cancelled: wait for bounded validation before
                # closing its input/output files, and never proceed to storage.
                try:
                    prepared = await task
                except Exception:
                    pass
                raise
            results = []
            for item in prepared.items:
                if item.get('status') == 'error':
                    results.append(item)
                    continue
                prepared.data.seek(item['position'])
                data = json.loads(prepared.data.read(item['length']))
                try:
                    await manager.add_antigravity_credential(item['filename'], data)
                    results.append({'filename':item['filename'], 'status':'success', 'message':'上传成功'})
                except CredentialStorageError as exc:
                    results.append({'filename':item['filename'], 'status':'error',
                                    'error_code':exc.code, 'message':str(exc)})
                except Exception:
                    results.append({'filename':item['filename'], 'status':'error',
                                    'error_code':'credential_import_failed', 'message':'凭证处理失败'})
            count = sum(item['status'] == 'success' for item in results)
            payload = {'uploaded_count':count, 'total_count':len(results),
                       'failed_count':len(results)-count, 'results':results,
                       'message':f'批量上传完成: 成功 {count}/{len(results)} 个 antigravity 文件'}
            if not count:
                payload['detail'] = '没有 antigravity 文件上传成功'
            return JSONResponse(status_code=200 if count else 400, content=payload)
        finally:
            if prepared is not None:
                prepared.close()


async def upload_antigravity_files(files, manager):
    try:
        return await _upload_antigravity_files(files, manager)
    finally:
        for upload in files:
            await upload.close()

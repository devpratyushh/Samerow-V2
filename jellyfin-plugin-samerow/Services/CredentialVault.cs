// Copyright (c) 2026 devpratyushh
// SPDX-License-Identifier: GPL-3.0-or-later

using System.Security.Cryptography;
using System.Text;

namespace SameRow.Plugin.Services;

/// <summary>Protects saved credentials with a server-local, owner-readable key.</summary>
public sealed class CredentialVault
{
    private readonly byte[] _key;

    public CredentialVault(string directory)
    {
        Directory.CreateDirectory(directory);
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        var path = Path.Combine(directory, "credential.key");
        if (!File.Exists(path))
        {
            try
            {
                var options = new FileStreamOptions
                {
                    Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None
                };
                if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
                using var stream = new FileStream(path, options);
                stream.Write(RandomNumberGenerator.GetBytes(32));
                stream.Flush(true);
            }
            catch (IOException) when (File.Exists(path)) { }
        }
        _key = File.ReadAllBytes(path);
        if (_key.Length != 32) throw new CryptographicException("SameRow credential key is invalid.");
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    }

    public string Protect(string token)
    {
        if (string.IsNullOrEmpty(token)) return "";
        var plaintext = Encoding.UTF8.GetBytes(token);
        var output = new byte[12 + 16 + plaintext.Length];
        RandomNumberGenerator.Fill(output.AsSpan(0, 12));
        using var aes = new AesGcm(_key, 16);
        aes.Encrypt(output.AsSpan(0, 12), plaintext, output.AsSpan(28), output.AsSpan(12, 16), "SameRow credential v1"u8);
        return Convert.ToBase64String(output);
    }

    public string Unprotect(string value)
    {
        if (string.IsNullOrEmpty(value)) return "";
        var input = Convert.FromBase64String(value);
        if (input.Length < 28) throw new CryptographicException("SameRow credential is invalid.");
        var plaintext = new byte[input.Length - 28];
        using var aes = new AesGcm(_key, 16);
        aes.Decrypt(input.AsSpan(0, 12), input.AsSpan(28), input.AsSpan(12, 16), plaintext, "SameRow credential v1"u8);
        return Encoding.UTF8.GetString(plaintext);
    }
}

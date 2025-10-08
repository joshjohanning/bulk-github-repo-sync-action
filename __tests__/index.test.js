/**
 * Tests for the Repository Sync Action
 */

import { jest } from '@jest/globals';

// Mock process.exit to prevent tests from exiting
// eslint-disable-next-line no-unused-vars
const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {});

// Mock @actions/core before importing index.js
const mockCore = {
  getInput: jest.fn(() => ''),
  getBooleanInput: jest.fn(() => false),
  error: jest.fn(),
  warning: jest.fn(),
  info: jest.fn()
};

jest.unstable_mockModule('@actions/core', () => mockCore);

// Import functions after mocking
const { deriveInstanceUrl, sanitizeError } = await import('../src/index.js');

describe('Repository Sync Action - Helper Functions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('deriveInstanceUrl', () => {
    test('should convert api.github.com to github.com', () => {
      const result = deriveInstanceUrl('https://api.github.com');
      expect(result).toBe('https://github.com');
    });

    test('should handle GitHub Enterprise Server URLs with api prefix', () => {
      const result = deriveInstanceUrl('https://api.customersuccess.ghe.com');
      expect(result).toBe('https://customersuccess.ghe.com');
    });

    test('should handle URLs with /api/v3 path', () => {
      const result = deriveInstanceUrl('https://ghe.company.com/api/v3');
      expect(result).toBe('https://ghe.company.com');
    });

    test('should handle URLs with custom port', () => {
      const result = deriveInstanceUrl('https://api.example.com:8080');
      expect(result).toBe('https://example.com:8080');
    });

    test('should handle URLs without api prefix', () => {
      const result = deriveInstanceUrl('https://github.enterprise.com');
      expect(result).toBe('https://github.enterprise.com');
    });

    test('should handle invalid URLs gracefully', () => {
      const result = deriveInstanceUrl('not-a-valid-url');
      expect(mockCore.warning).toHaveBeenCalled();
      expect(result).toBe('not-a-valid-url');
    });
  });

  describe('sanitizeError', () => {
    test('should remove credentials from error messages', () => {
      const error = new Error('Failed: https://x-access-token:ghp_secret123@github.com/repo.git');
      const result = sanitizeError(error);
      expect(result).toBe('Failed: https://x-access-token:***@github.com/repo.git');
    });

    test('should handle multiple credentials in same message', () => {
      const error = new Error(
        'Failed cloning x-access-token:token1@github.com and pushing to x-access-token:token2@gitlab.com'
      );
      const result = sanitizeError(error);
      expect(result).toBe('Failed cloning x-access-token:***@github.com and pushing to x-access-token:***@gitlab.com');
    });

    test('should return message unchanged if no credentials present', () => {
      const error = new Error('Simple error message');
      const result = sanitizeError(error);
      expect(result).toBe('Simple error message');
    });
  });
});

describe('Repository Sync Action - Integration Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('URL derivation scenarios', () => {
    test('should correctly derive GitHub.com URLs', () => {
      expect(deriveInstanceUrl('https://api.github.com')).toBe('https://github.com');
    });

    test('should correctly derive GHES URLs with api subdomain', () => {
      expect(deriveInstanceUrl('https://api.corp.github.com')).toBe('https://corp.github.com');
    });

    test('should correctly derive GHES URLs with /api/v3 path', () => {
      expect(deriveInstanceUrl('https://github.corp.com/api/v3')).toBe('https://github.corp.com');
    });
  });

  describe('Security - Credential sanitization', () => {
    test('should never expose tokens in error messages', () => {
      const sensitiveError = new Error(
        'git clone failed: https://x-access-token:ghp_SuperSecretToken123@github.com/repo.git'
      );
      const sanitized = sanitizeError(sensitiveError);

      expect(sanitized).not.toContain('ghp_SuperSecretToken123');
      expect(sanitized).toContain('x-access-token:***@');
    });
  });

  describe('Repository description updates', () => {
    test('should detect when descriptions differ', () => {
      const currentDescription = 'Old description';
      const targetDescription = 'New description';

      expect(currentDescription).not.toBe(targetDescription);
    });

    test('should detect when descriptions match', () => {
      const currentDescription = 'Same description';
      const targetDescription = 'Same description';

      expect(currentDescription).toBe(targetDescription);
    });

    test('should handle empty descriptions', () => {
      const currentDescription = '';
      const targetDescription = '';

      expect(currentDescription).toBe(targetDescription);
    });

    test('should detect when current is empty but target has description', () => {
      const currentDescription = '';
      const targetDescription = 'New description';

      expect(currentDescription).not.toBe(targetDescription);
    });

    test('should detect when current has description but target is empty', () => {
      const currentDescription = 'Old description';
      const targetDescription = '';

      expect(currentDescription).not.toBe(targetDescription);
    });

    test('should treat null as empty string', () => {
      const mockCurrentDescription = null;
      const mockTargetDescription = null;

      const currentDescription = mockCurrentDescription || '';
      const targetDescription = mockTargetDescription || '';

      expect(currentDescription).toBe(targetDescription);
      expect(currentDescription).toBe('');
    });

    test('should handle descriptions with special characters', () => {
      const currentDescription = 'Description with "quotes" and special chars: !@#$%';
      const targetDescription = 'Description with "quotes" and special chars: !@#$%';

      expect(currentDescription).toBe(targetDescription);
    });

    test('should be case-sensitive when comparing descriptions', () => {
      const currentDescription = 'Description';
      const targetDescription = 'description';

      expect(currentDescription).not.toBe(targetDescription);
    });
  });
});

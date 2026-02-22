import { isValidYoutubeUrl, YOUTUBE_URL_REGEX } from './youtube.constants';

describe('YouTube URL Validation', () => {
  describe('isValidYoutubeUrl', () => {
    describe('valid URLs', () => {
      const validUrls = [
        // Standard watch URLs
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'http://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://youtube.com/watch?v=dQw4w9WgXcQ',
        'http://youtube.com/watch?v=dQw4w9WgXcQ',
        'www.youtube.com/watch?v=dQw4w9WgXcQ',
        'youtube.com/watch?v=dQw4w9WgXcQ',

        // Short URLs (youtu.be)
        'https://youtu.be/dQw4w9WgXcQ',
        'http://youtu.be/dQw4w9WgXcQ',
        'youtu.be/dQw4w9WgXcQ',

        // Mobile URLs
        'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
        'm.youtube.com/watch?v=dQw4w9WgXcQ',

        // YouTube Music URLs
        'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
        'music.youtube.com/watch?v=dQw4w9WgXcQ',

        // Shorts URLs
        'https://www.youtube.com/shorts/dQw4w9WgXcQ',
        'https://youtube.com/shorts/dQw4w9WgXcQ',
        'youtube.com/shorts/dQw4w9WgXcQ',

        // Embed URLs
        'https://www.youtube.com/embed/dQw4w9WgXcQ',
        'https://youtube.com/embed/dQw4w9WgXcQ',

        // V URLs
        'https://www.youtube.com/v/dQw4w9WgXcQ',
        'https://youtube.com/v/dQw4w9WgXcQ',

        // With additional parameters
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=120',
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf',

        // Longer video IDs (some videos have IDs longer than 11 chars)
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ_extra',
      ];

      validUrls.forEach((url) => {
        it(`should accept: ${url}`, () => {
          expect(isValidYoutubeUrl(url)).toBe(true);
        });
      });
    });

    describe('invalid URLs', () => {
      const invalidUrls = [
        // UUIDs (the original bug)
        'abc12345-1234-5678-abcd-1234567890ab',
        '550e8400-e29b-41d4-a716-446655440000',

        // Random strings
        'not-a-url',
        'hello world',
        '',

        // Other video platforms
        'https://vimeo.com/123456789',
        'https://dailymotion.com/video/x123456',
        'https://www.tiktok.com/@user/video/123456',

        // Malformed YouTube URLs
        'https://youtube.com/',
        'https://youtube.com/watch',
        'https://youtube.com/watch?v=',
        'https://youtu.be/',

        // Typos in domain
        'https://youtubee.com/watch?v=dQw4w9WgXcQ',
        'https://youtube.org/watch?v=dQw4w9WgXcQ',
        'https://yutube.com/watch?v=dQw4w9WgXcQ',

        // SQL injection attempts
        "https://youtube.com/watch?v='; DROP TABLE users;--",

        // Script injection
        'https://youtube.com/watch?v=<script>alert(1)</script>',
      ];

      invalidUrls.forEach((url) => {
        it(`should reject: ${url}`, () => {
          expect(isValidYoutubeUrl(url)).toBe(false);
        });
      });
    });
  });

  describe('YOUTUBE_URL_REGEX', () => {
    it('should be a RegExp', () => {
      expect(YOUTUBE_URL_REGEX).toBeInstanceOf(RegExp);
    });

    it('should extract video ID from standard URL', () => {
      const match = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'.match(YOUTUBE_URL_REGEX);
      expect(match).not.toBeNull();
      expect(match![5]).toBe('dQw4w9WgXcQ');
    });

    it('should extract video ID from short URL', () => {
      const match = 'https://youtu.be/dQw4w9WgXcQ'.match(YOUTUBE_URL_REGEX);
      expect(match).not.toBeNull();
      expect(match![5]).toBe('dQw4w9WgXcQ');
    });
  });
});

# Contributing to Uplynk HLS.js Monitor

Thank you for your interest in contributing! This document provides guidelines for contributing to the project.

## 🎯 Ways to Contribute

- 🐛 Report bugs
- 💡 Suggest features
- 📝 Improve documentation
- 🔧 Submit code changes
- 🧪 Test with different streams
- 💬 Help others in discussions

## 🐛 Reporting Bugs

Before submitting a bug report:

1. Check existing [issues](https://github.com/jj358mhz/player_test_harness/issues)
2. Test with multiple streams if possible
3. Try different browsers
4. Enable debug mode and check console

### Bug Report Template

When creating a bug report, please include:

**Describe the bug**
A clear description of the bug.

**To Reproduce**
1. Load stream URL: ...
2. Click on...
3. See error

**Expected behavior**
What you expected to happen.

**Screenshots/Console Output**
If applicable.

**Environment:**
- Browser: [e.g. Chrome 120]
- OS: [e.g. macOS 14]
- Stream URL: [if public]
- HLS.js Version: [e.g. 1.6.15]
- Uplynk Slicer wallclock setting: [e.g. wallclock: 1]

**Additional context**
Any other relevant information.

## 💡 Suggesting Features

Feature requests are welcome! Please:

1. Check if it's already requested
2. Describe the use case
3. Explain expected behavior
4. Provide examples if applicable

### Feature Request Template

When creating a feature request, please include:

**Is your feature request related to a problem?**
Clear description of the problem.

**Describe the solution you'd like**
What you want to happen.

**Describe alternatives you've considered**
Other solutions you've thought about.

**Use case**
Why this feature would be useful.

**Example streams**
Links to test streams (if applicable).

## 🔧 Code Contributions

### Getting Started

1. **Clone the repository**
```bash
   git clone https://github.com/jj358mhz/player_test_harness.git
   cd player_test_harness
```

2. **Create a branch**
```bash
   git checkout -b feature/your-feature-name
```

3. **Open the file**
```bash
   # Edit app/player/hls-id3-player.html
   open app/player/hls-id3-player.html
```

### Development Guidelines

#### Code Style

- Use ES6+ JavaScript
- 4-space indentation
- Clear variable names
- Comment complex logic
- Follow existing patterns

#### Example:
```javascript
// Good
function updateLatencyStats(latencyMs) {
    latencyData.current = latencyMs;
    latencyData.samples.push(latencyMs);
    
    // Calculate average
    const avg = latencyData.samples.reduce((a, b) => a + b, 0) / latencyData.samples.length;
}

// Avoid
function f(x) {
    return x.reduce((a, b) => a + b) / x.length;
}
```

#### Performance Considerations

- Cache DOM elements
- Throttle expensive operations
- Use batch updates
- Prefer `requestAnimationFrame` for animations
```javascript
// Good - cached and throttled
const domCache = { element: document.getElementById('foo') };
const updateElement = throttle(() => {
    domCache.element.textContent = 'bar';
}, 100);

// Avoid - repeated lookups
setInterval(() => {
    document.getElementById('foo').textContent = 'bar';
}, 16);
```

#### Testing Your Changes

1. **Test with multiple streams:**
   - Clear (unencrypted)
   - Encrypted (AES-128, SAMPLE-AES)
   - DRM (Widevine, PlayReady)
   - Live vs VOD
   - Different codecs (H.264, HEVC)
   - Different formats (fMP4, TS, CMAF)
   - **With and without `wallclock: 1` enabled**

2. **Test in multiple browsers:**
   - Chrome
   - Firefox
   - Safari
   - Mobile browsers

3. **Test edge cases:**
   - No ID3 metadata
   - Missing timestamps
   - Very high/low latency
   - Network errors
   - Discontinuities
   - Key rotations
   - Slicer with `wallclock: 0`

4. **Check console:**
   - No errors
   - No excessive logging (unless debug mode)
   - Performance warnings addressed

### Commit Guidelines

Use clear, descriptive commit messages:
```bash
# Good commits
git commit -m "Add key rotation detection in DRM monitor"
git commit -m "Fix: Audio level meter not updating"
git commit -m "Improve: Throttle graph rendering to 30fps"
git commit -m "Docs: Update README with wallclock prerequisite"

# Avoid
git commit -m "fix stuff"
git commit -m "updates"
```

### Pull Request Process

1. **Update documentation** if needed
2. **Test thoroughly**
3. **Push to your branch**
```bash
   git push origin feature/your-feature-name
```

4. **Open a Pull Request** on GitHub

5. **PR Description Template:**

   **Description**
   Brief description of changes.
   
   **Type of change**
   - [ ] Bug fix
   - [ ] New feature
   - [ ] Breaking change
   - [ ] Documentation update
   
   **Testing**
   - [ ] Tested with multiple streams
   - [ ] Tested in multiple browsers
   - [ ] No console errors
   - [ ] Performance acceptable
   - [ ] Tested with wallclock enabled/disabled
   
   **Checklist**
   - [ ] Code follows project style
   - [ ] Comments added where needed
   - [ ] Documentation updated
   - [ ] No breaking changes (or documented)
   
   **Related Issues**
   Closes #123

6. **Respond to feedback** from reviewers

## 📝 Documentation Contributions

Documentation improvements are always welcome:

- Fix typos
- Clarify instructions
- Add examples
- Update screenshots
- Translate to other languages

Small fixes can be done directly on GitHub. Larger changes should follow the PR process.

## 🧪 Testing Contributions

Help test the tool:

- Try different stream types
- Test on different devices/browsers
- Report compatibility issues
- Verify fixes work as expected
- Test with various slicer configurations

## 💬 Community

- Be respectful and constructive
- Help others when possible
- Share your use cases
- Provide feedback

## 📄 License

By contributing, you agree that your contributions will be licensed under the MIT License.

## ❓ Questions?

- Open an [Issue](https://github.com/jj358mhz/player_test_harness/issues)

---

**Thank you for contributing! 🎉**
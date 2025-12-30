// Mock Slack module for testing
class Slack {
  static async send() {
    // Mock implementation
    return true;
  }
}

module.exports = Slack;

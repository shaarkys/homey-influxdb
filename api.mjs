export default {
  async getStatus({ homey }) {
    return homey.app.getStatus();
  }
};
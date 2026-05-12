import axios from 'axios';
import { logger } from './src/config/logger.js';

export default class XtreamClient {
    constructor(baseUrl, username, password, userAgent = 'Xtream-JS-Client') {
        if (!baseUrl || typeof baseUrl !== 'string') {
            throw new Error('[XC Client] Invalid or missing baseUrl provided.');
        }
        try {
            const url = new URL(baseUrl);
            this.baseUrl = `${url.protocol}//${url.host}`;
        } catch (e) {
            logger.error({ baseUrl, err: e }, 'Failed to parse XC baseUrl');
            throw new Error(`[XC Client] Invalid baseUrl format: "${baseUrl}". Use http://example.com:8080`);
        }

        this.username = username;
        this.password = password;
        this.client = axios.create({
            timeout: 60000,
            headers: { 'User-Agent': userAgent },
        });
    }

    async _makeRequest(action, params = {}) {
        try {
            const url = `${this.baseUrl}/player_api.php`;
            const response = await this.client.get(url, { params: { username: this.username, password: this.password, action, ...params } });
            if (!response.data) throw new Error('Empty response from provider');
            return response.data;
        } catch (error) {
            throw new Error(`[XC Client] Error in action '${action}': ${error.message}`);
        }
    }

    async getVodStreams() { return this._makeRequest('get_vod_streams'); }
    async getSeries() { return this._makeRequest('get_series'); }
    async getVodInfo(vodId) { return this._makeRequest('get_vod_info', { vod_id: vodId }); }
    async getSeriesInfo(seriesId) { return this._makeRequest('get_series_info', { series_id: seriesId }); }
    async getVodCategories() { return this._makeRequest('get_vod_categories'); }
    async getSeriesCategories() { return this._makeRequest('get_series_categories'); }
    async getLiveCategories() { return this._makeRequest('get_live_categories'); }

    async getAllCategories() {
        try {
            const [live, vod, series] = await Promise.all([
                this.getLiveCategories(), this.getVodCategories(), this.getSeriesCategories(),
            ]);
            const all = new Set();
            [live, vod, series].forEach(arr => {
                if (Array.isArray(arr)) arr.forEach(c => all.add(c.category_name));
            });
            return [...all].sort((a, b) => a.localeCompare(b));
        } catch (error) {
            throw new Error(`Failed to fetch all categories: ${error.message}`);
        }
    }
}

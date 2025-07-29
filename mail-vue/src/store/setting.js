import { defineStore } from 'pinia'

export const useSettingStore = defineStore('setting', {
    state: () => ({
        domainList: [],
        settings: {
            r2Domain: '',
            loginOpacity: 1.00,
        },
        lang: '',
    }),
    actions: {

    },
    persist: {
        storage: sessionStorage,
        pick: ['lang'],
    },
})

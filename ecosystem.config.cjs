module.exports = {
    apps: [
        {
            name: 'rsshub',
            script: 'dist/index.mjs',
            node_args: '--max-http-header-size=32768',
            env: {
                NODE_ENV: 'production',
                BILIBILI_COOKIE_33054056:
                    "buvid3=995C49F6-0896-49F7-0684-3D9292569C9964163infoc; b_nut=1774623664; _uuid=FE3107EE2-81E1-8B6E-339B-9BEB768C9F9864660infoc; buvid_fp=ed9c7c15be5bc6e0e0e963a6929db765; buvid4=6AF6ED5D-6636-CC20-5C99-7D1B8F970C0164950-026032723-jYb7sY54os0Bq3wt59k7UA%3D%3D; rpdid=|(k|kmkY))R)0J'u~~RYkJYYl; theme-tip-show=SHOWED; theme-avatar-tip-show=SHOWED; theme-switch-show=SHOWED; theme_style=dark; hit-dyn-v2=1; bmg_af_switch=1; bmg_src_def_domain=i1.hdslb.com; bp_t_offset_33054056=1251113673993224192; CURRENT_QUALITY=0; SESSDATA=665f11dd%2C1805781766%2C8bb7b%2A91CjBxcRiAViSd-N_xkVGuD-zWQjE8dBFz4GLH2ifR5ZMpwDiMBLSuPUnHuLDO1lAXoA4SVmkyM091a3Z2QmxWTUppTjlMVmZqMUxYSnhSSnZPRjBnMVFZaGhPcnJJOHZwazZPQkY5Rk80ZGpWLUVGRDluVkNBRFpQZWlxNFEwMmU1Vi1MaUt1RlhBIIEC; bili_jct=ad0c84aae3696afec2f7a8b5b69010c3; DedeUserID=33054056; DedeUserID__ckMd5=5726b91637644488; CURRENT_FNVAL=2000; sid=7vu7qcj9; home_feed_column=4; browser_resolution=1224-780; b_lsid=FAAF2CFA_1A0D405393D",
            },
        },
    ],
};

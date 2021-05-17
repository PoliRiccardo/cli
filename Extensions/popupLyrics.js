// @ts-check

// NAME: Popup Lyrics
// AUTHOR: khanhas
//         Netease API parser and UI from https://github.com/mantou132/Spotify-Lyrics
// DESCRIPTION: Pop lyrics up

/// <reference path="../globals.d.ts" />

if (!navigator.serviceWorker) {
    // Worker code
    // When Spotify client is minimised, requestAnimationFrame does not call our tick function
    // setTimeout and setInterval are also throttled at 1 second.
    // Offload setInterval to a Worker to consistenly call tick function.
    let num = null;
    onmessage = function (event) {
        if (event.data === "popup-lyric-request-update") {
            console.warn("popup-lyric-request-update");
            num = setInterval(() => postMessage("popup-lyric-update-ui"), 8);
        } else if (event.data === "popup-lyric-stop-update") {
            clearInterval(num);
            num = null;
        }
    };

} else {
    PopupLyrics();
}

function PopupLyrics() {
    const topBar = document.querySelector(".main-topBar-historyButtons");
    const {
        Player,
        CosmosAsync,
        LocalStorage,
        ContextMenu
    } = Spicetify;

    if (!topBar || !Player || !Player.data ||
        !CosmosAsync || !LocalStorage || !ContextMenu) {
        setTimeout(PopupLyrics, 500);
        return;
    }

    const worker = new Worker ("./popupLyrics.js");
    worker.onmessage = function (event) {
        if (event.data === "popup-lyric-update-ui") {
            tick(userConfigs);
        } 
    }

    class LyricUtils {
        static normalize(s, emptySymbol = true) {
            const result = s
                .replace(/（/g, '(')
                .replace(/）/g, ')')
                .replace(/【/g, '[')
                .replace(/】/g, ']')
                .replace(/。/g, '. ')
                .replace(/；/g, '; ')
                .replace(/：/g, ': ')
                .replace(/？/g, '? ')
                .replace(/！/g, '! ')
                .replace(/、|，/g, ', ')
                .replace(/‘|’|′|＇/g, "'")
                .replace(/“|”/g, '"')
                .replace(/〜/g, '~')
                .replace(/·|・/g, '•');
            if (emptySymbol) {
                result.replace(/-/g, ' ').replace(/\//g, ' ');
            }
            return result.replace(/\s+/g, ' ').trim();
        }

        static removeSongFeat(s) {
            return (
                s
                .replace(/-\s+(feat|with).*/i, '')
                .replace(/(\(|\[)(feat|with)\.?\s+.*(\)|\])$/i, '')
                .trim() || s
            );
        }

        static capitalize(s) {
            return s.replace(/^(\w)/, ($1) => $1.toUpperCase());
        }
    }

    class LyricProviders {
        static async fetchSpotify(info) {
            const baseURL = "hm://lyrics/v1/track/";
            const id = info.uri.split(":")[2];
            const body = await CosmosAsync.get(baseURL + id);

            const lines = body.lines;
            if (
                !lines ||
                !lines.length ||
                typeof lines[0].time !== "number"
            ) {
                return { error: "No lyric"};
            }

            const lyrics = lines
                .map((a) => ({
                    startTime: a.time / 1000,
                    text: a.words
                        .map(b => b.string)
                        .join(" "),
                }));

            return { lyrics };
        }

        static async fetchMusixmatch(info) {
            const baseURL = `https://apic-desktop.musixmatch.com/ws/1.1/macro.subtitles.get?format=json&namespace=lyrics_synched&subtitle_format=mxm&app_id=web-desktop-app-v1.0&`;

            const durr = info.duration / 1000;

            const params = {
                q_album: info.album,
                q_artist: info.artist,
                q_artists: info.artist,
                q_track: info.title,
                track_spotify_id: info.uri,
                q_duration: durr,
                f_subtitle_length: Math.floor(durr),
                usertoken: userConfigs.services.musixmatch.token,
            };

            const finalURL = baseURL + Object.keys(params)
                .map(key => key + "=" + encodeURIComponent(params[key]))
                .join("&");

            try {
                let body = await CosmosAsync.get(
                    finalURL,
                    null,
                    {
                        authority: "apic-desktop.musixmatch.com",
                        cookie: "x-mxm-token-guid=",
                    }
                );
            
                body = body.message.body.macro_calls;

                if (body["matcher.track.get"].message.header.status_code !== 200) {
                    return {
                        error: `Requested error: ${body["matcher.track.get"].message.header.mode}`
                    };
                }

                const meta = body["matcher.track.get"].message.body;
                const hasSynced = meta.track.has_subtitles;

                if (hasSynced) {
                    const subtitle = body["track.subtitles.get"].message.body.subtitle_list[0].subtitle;

                    const lyrics = JSON.parse(subtitle.subtitle_body)
                        .map(line => ({
                            text: line.text || "⋯",
                            startTime: line.time.total,
                        }));
                    return { lyrics };

                } else {
                    return { error: "No lyric" };
                }

            } catch (err) {
                return { error: err.message };
            }
        };

        static async fetchNetease(info) {
            const searchURL = `https://music.xianqiao.wang/neteaseapi/search?limit=10&type=1&keywords=`;
            const lyricURL = `https://music.xianqiao.wang/neteaseapi/lyric?id=`;

            const cleanTitle = LyricUtils.removeSongFeat(LyricUtils.normalize(info.title));
            const finalURL = searchURL + encodeURIComponent(`${cleanTitle} ${info.artist}`);

            const searchResults = await CosmosAsync.get(finalURL);
            const items = searchResults.result.songs;
            if (!items || !items.length) {
                return { error: "Cannot find track" };
            }

            const album = LyricUtils.capitalize(info.album);
            let itemId = items.findIndex((val) => LyricUtils.capitalize(val.album.name) === album);
            if (itemId === -1) itemId = 0;

            const meta = await CosmosAsync.get(lyricURL + items[itemId].id);
            let lyricStr = meta.lrc;

            if (!lyricStr || !lyricStr.lyric) {
                return { error: "No lyric" };
            }
            lyricStr = lyricStr.lyric;

            const otherInfoKeys = [
                '作?\\s*词|作?\\s*曲|编\\s*曲?|监\\s*制?',
                '.*编写|.*和音|.*和声|.*合声|.*提琴|.*录|.*工程|.*工作室|.*设计|.*剪辑|.*制作|.*发行|.*出品|.*后期|.*混音|.*缩混',
                '原唱|翻唱|题字|文案|海报|古筝|二胡|钢琴|吉他|贝斯|笛子|鼓|弦乐',
                'lrc|publish|vocal|guitar|program|produce|write',
            ];
            const otherInfoRegexp = new RegExp(`^(${otherInfoKeys.join('|')}).*(:|：)`, 'i');

            const lines = lyricStr.split(/\r?\n/).map((line) => line.trim());
            const lyrics = lines
                .map((line) => {
                    // ["[ar:Beyond]"]
                    // ["[03:10]"]
                    // ["[03:10]", "永远高唱我歌"]
                    // ["永远高唱我歌"]
                    // ["[03:10]", "[03:10]", "永远高唱我歌"]
                    const matchResult = line.match(/(\[.*?\])|([^\[\]]+)/g) || [line];
                    if (!matchResult.length) {
                        return;
                    }
                    const textIndex = matchResult.findIndex((slice) => !slice.endsWith(']'));
                    let text = '';
                    if (textIndex > -1) {
                        text = matchResult.splice(textIndex, 1)[0];
                        text = LyricUtils.capitalize(LyricUtils.normalize(text, false));
                    }
                    return matchResult.map((slice) => {
                        const result = {};
                        const matchResut = slice.match(/[^\[\]]+/g);
                        const [key, value] = matchResut[0].split(':') || [];
                        const [min, sec] = [parseFloat(key), parseFloat(value)];
                        if (!isNaN(min) && !otherInfoRegexp.test(text)) {
                            result.startTime = min * 60 + sec;
                            result.text = text || "...";
                        }
                        return result;
                    });
                })
                .flat()
                .sort((a, b) => {
                    if (a.startTime === null) {
                        return 0;
                    }
                    if (b.startTime === null) {
                        return 1;
                    }
                    return a.startTime - b.startTime;
                })
                .filter(({ text }, index, arr) => {
                    if (index) {
                        const prevEle = arr[index - 1];
                        if (prevEle.text === text && text === '') {
                            return false;
                        }
                    }
                    return true;
                });

            if (!lyrics.length) {
                return { error: "No synced lyrics" };
            }

            return { lyrics };
        }
    }

    const userConfigs = {
        smooth: boolLocalStorage("popup-lyrics:smooth"),
        centerAlign: boolLocalStorage("popup-lyrics:center-align"),
        showCover: boolLocalStorage("popup-lyrics:show-cover"),
        fontSize: LocalStorage.get("popup-lyrics:font-size"),
        fontFamily: LocalStorage.get("popup-lyrics:font-family") || "spotify-circular",
        ratio: LocalStorage.get("popup-lyrics:ratio") || "11",
        services: {
            netease: {
                on: boolLocalStorage("popup-lyrics:services:netease:on"),
                call: LyricProviders.fetchNetease,
                desc: `Crowd sourced lyrics provider running by Chinese developers and users.`,
            },
            musixmatch: {
                on: boolLocalStorage("popup-lyrics:services:musixmatch:on"),
                call: LyricProviders.fetchMusixmatch,
                desc: `Fully compatible with Spotify. Require a token that can be retrieved from Musixmatch offical app. Follow instructions on <a href="https://github.com/khanhas/spicetify-cli/wiki/Musixmatch-Token">spicetify Wiki</a>.`,
                token: LocalStorage.get("popup-lyrics:services:musixmatch:token") || "2005218b74f939209bda92cb633c7380612e14cb7fe92dcd6a780f",
            },
            spotify: {
                on: boolLocalStorage("popup-lyrics:services:spotify:on"),
                call: LyricProviders.fetchSpotify,
                desc: `Lyrics are offically provided by Spotify. Only available for some regions/countries' users (e.g Japan, Vietnam, Thailand).`,
            },
        },
        servicesOrder: [],
    };

    userConfigs.fontSize = userConfigs.fontSize ? Number(userConfigs.fontSize) : 46;
    try {
        const rawServicesOrder = LocalStorage.get("popup-lyrics:services-order");
        userConfigs.servicesOrder = JSON.parse(rawServicesOrder);

        if (!Array.isArray(userConfigs.servicesOrder)) throw "";

        userConfigs.servicesOrder = userConfigs.servicesOrder
            .filter(s => userConfigs.services[s]) // Remove obsoleted services

        const allServices = Object.keys(userConfigs.services);
        if (userConfigs.servicesOrder.length !== allServices.length) {
            allServices.forEach(s => {
                if (!userConfigs.servicesOrder.includes(s)) {
                    userConfigs.servicesOrder.push(s);
                }
            });
            LocalStorage.set(
                "popup-lyrics:services-order",
                JSON.stringify(userConfigs.servicesOrder)
            );
        }

    } catch {
        userConfigs.servicesOrder = Object.keys(userConfigs.services);
        LocalStorage.set(
            "popup-lyrics:services-order",
            JSON.stringify(userConfigs.servicesOrder)
        );
    }

    const lyricVideo = document.createElement('video');
    lyricVideo.muted = true;
    lyricVideo.width = 600;
    switch(userConfigs.ratio) {
        case "43": lyricVideo.height = Math.round(lyricVideo.width * 3 / 4);; break;
        case "169": lyricVideo.height = Math.round(lyricVideo.width * 9 / 16);; break;
        default: lyricVideo.height = lyricVideo.width; break;
    }

    let lyricVideoIsOpen = false;
    lyricVideo.onenterpictureinpicture = () => {
        lyricVideoIsOpen = true;
        tick(userConfigs);
        updateTrack();
    };
    lyricVideo.onleavepictureinpicture = () => lyricVideoIsOpen = false;

    const lyricCanvas = document.createElement('canvas');
    lyricCanvas.width = lyricVideo.width;
    lyricCanvas.height = lyricVideo.height;

    const lyricCtx = lyricCanvas.getContext('2d');
    lyricVideo.srcObject = lyricCanvas.captureStream();
    lyricCtx.fillRect(0, 0, 1, 1);
    lyricVideo.play();

    const button = document.createElement("button");
    button.classList.add("main-topBar-button")
    button.innerHTML = `<svg role="img" height="16" width="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20 7c0-3.309-2.691-6-6-6S8 3.691 8 7c0 .697.126 1.363.345 1.985L3.697 19.421a1.498 1.498 0 00.62 1.91l1.293.747a1.5 1.5 0 001.89-.325l7.561-8.852C17.865 12.396 20 9.945 20 7zM6.741 21.103a.498.498 0 01-.63.108l-1.293-.747a.5.5 0 01-.207-.636l4.301-9.662a5.995 5.995 0 004.763 2.817l-6.934 8.12zM14 12c-2.757 0-5-2.243-5-5s2.243-5 5-5 5 2.243 5 5-2.244 5-5 5z"/></svg>`;
    button.setAttribute("title", "Popup Lyrics");
    button.setAttribute("data-contextmenu", "");
    button.setAttribute("data-uri", "spotify:special:popup-lyrics");
    button.onclick = () => {
        if (!lyricVideoIsOpen) {
            lyricVideo.requestPictureInPicture();
        } else {
            document.exitPictureInPicture();
        }
    };
    topBar.append(button);

    const coverCanvas = document.createElement('canvas');
    coverCanvas.width = lyricVideo.width;
    coverCanvas.height = lyricVideo.width;
    const coverCtx = coverCanvas.getContext('2d');

    const largeImage = new Image();
    largeImage.onload = () => {
        coverCtx.drawImage(largeImage, 0, 0, coverCtx.canvas.width, coverCtx.canvas.width);
    };
    userConfigs.backgroundImage = coverCanvas;

    let sharedData = {};

    Player.addEventListener("songchange", updateTrack);

    async function updateTrack() {
        if (!lyricVideoIsOpen) {
            return;
        }

        const meta = Player.data.track.metadata;

        if (!Spicetify.URI.isTrack(Player.data.track.uri) &&
            !Spicetify.URI.isLocalTrack(Player.data.track.uri)) {
            return;
        }

        largeImage.src = meta.image_url;
        const info = {
            duration: Number(meta.duration),
            album: meta.album_title,
            artist: meta.artist_name,
            title: meta.title,
            uri: Player.data.track.uri,
        };

        sharedData = { lyrics: [] };
        let error = null;

        for (let name of userConfigs.servicesOrder) {
            const service = userConfigs.services[name];
            if (!service.on) continue;

            try {
                const data = await service.call(info);
                console.log(data);
                if (!data.error && data.lyrics) {
                    sharedData = data;
                    return;
                }
            } catch(err) {
                error = err;
            }
        }
        if (error || !sharedData.lyrics) {
            sharedData = { error: "No lyric" };
        }
    }

    // simple word segmentation rules
    function getWords(str) {
        const result = [];
        const words = str.split(
            /(\p{sc=Han}|\p{sc=Katakana}|\p{sc=Hiragana}|\p{sc=Hang}|\p{gc=Punctuation})|\s+/gu,
        );
        let tempWord = '';
        words.forEach((word = ' ') => {
            if (word) {
                if (tempWord && /(“|')$/.test(tempWord) && word !== ' ') {
                    // End of line not allowed
                    tempWord += word;
                } else if (/(,|\.|\?|:|;|'|，|。|？|：|；|”)/.test(word) && tempWord !== ' ') {
                    // Start of line not allowed
                    tempWord += word;
                } else {
                    if (tempWord) result.push(tempWord);
                    tempWord = word;
                }
            }
        });
        if (tempWord) result.push(tempWord);
        return result;
    }

    function drawParagraph(ctx, str = '', options) {
        let actualWidth = 0;
        const maxWidth = ctx.canvas.width - options.left - options.right;
        const words = getWords(str);
        const lines = [];
        const measures = [];
        let tempLine = '';
        let textMeasures = ctx.measureText('');
        for (let i = 0; i < words.length; i++) {
            const word = words[i];
            const line = tempLine + word;
            const mea = ctx.measureText(line);
            const isSpace = /\s/.test(word);
            if (mea.width > maxWidth && tempLine && !isSpace) {
                actualWidth = Math.max(actualWidth, textMeasures.width);
                lines.push(tempLine);
                measures.push(textMeasures);
                tempLine = word;
            } else {
                tempLine = line;
                if (!isSpace) {
                    textMeasures = mea;
                }
            }
        }
        if (tempLine !== '') {
            actualWidth = Math.max(actualWidth, textMeasures.width);
            lines.push(tempLine);
            measures.push(ctx.measureText(tempLine));
        }

        const ascent = measures.length ? measures[0].actualBoundingBoxAscent : 0;
        const body = measures.length ? options.lineHeight * (measures.length - 1) : 0;
        const descent = measures.length ? measures[measures.length - 1].actualBoundingBoxDescent : 0;
        const actualHeight = ascent + body + descent;

        let startX = 0;
        let startY = 0;
        let translateX = 0;
        let translateY = 0;
        if (options.hCenter) {
            startX = (ctx.canvas.width - actualWidth) / 2;
        } else {
            startX = options.left + translateX;
        }

        if (options.vCenter) {
            startY = (ctx.canvas.height - actualHeight) / 2 + ascent;
        } else if (options.top) {
            startY = options.top + ascent;
        } else if (options.bottom) {
            startY = options.bottom - descent - body;
        }

        if (typeof options.translateX === 'function') {
            translateX = options.translateX(actualWidth);
        }
        if (typeof options.translateX === 'number') {
            translateX = options.translateX;
        }
        if (typeof options.translateY === 'function') {
            translateY = options.translateY(actualHeight);
        }
        if (typeof options.translateY === 'number') {
            translateY = options.translateY;
        }
        if (!options.measure) {
            lines.forEach((str, index) => {
                const x = options.hCenter ? (ctx.canvas.width - measures[index].width) / 2 : startX;
                ctx.fillText(str, x, startY + index * options.lineHeight + translateY);
            });
        }
        return {
            width: actualWidth,
            height: actualHeight,
            left: startX + translateX,
            right: ctx.canvas.width - options.left - actualWidth + translateX,
            top: startY - ascent + translateY,
            bottom: startY + body + descent + translateY,
        };
    }

    function drawBackground(ctx, image) {
        if (userConfigs.showCover) {
            const { width, height } = ctx.canvas;
            ctx.imageSmoothingEnabled = false;
            const blur = 10;
            ctx.save();
            ctx.filter = `blur(${blur}px)`;
            ctx.drawImage(
                image, 
                -blur * 2,
                -blur * 2 - (width - height) / 2,
                width + 4 * blur,
                width + 4 * blur
            );
            ctx.restore();
            ctx.fillStyle = '#000000b0';
        } else {
            ctx.save();
            ctx.fillStyle = '#000000';
        }

        ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        ctx.restore();
    }

    function drawText(ctx, text, color = "white") {
        drawBackground(ctx, userConfigs.backgroundImage);
        const fontSize = userConfigs.fontSize;
        ctx.fillStyle = color;
        ctx.font = `bold ${fontSize}px ${userConfigs.fontFamily}, sans-serif`;
        drawParagraph(ctx, text, {
            vCenter: true,
            hCenter: true,
            left: 0,
            right: 0,
            lineHeight: fontSize,
        });
        ctx.restore();
    }

    let offscreenCanvas;
    let offscreenCtx;
    let gradient1;
    let gradient2;

    function initOffscreenCtx(ctx) {
        if (!offscreenCtx) {
            offscreenCanvas = document.createElement('canvas');
            offscreenCtx = offscreenCanvas.getContext('2d');
            gradient1 = offscreenCtx.createLinearGradient(0, 0, 0, ctx.canvas.height);
            gradient1.addColorStop(0.08, 'transparent');
            gradient1.addColorStop(0.15, 'white');
            gradient1.addColorStop(0.85, 'white');
            gradient1.addColorStop(0.92, 'transparent');
            gradient2 = offscreenCtx.createLinearGradient(0, 0, 0, ctx.canvas.height);
            gradient2.addColorStop(0.0, 'white');
            gradient2.addColorStop(0.7, 'white');
            gradient2.addColorStop(0.925, 'transparent');
        }
        offscreenCtx.canvas.width = ctx.canvas.width;
        offscreenCtx.canvas.height = ctx.canvas.height;
        return {
            offscreenCtx,
            gradient1,
            gradient2
        };
    }

    // Avoid drawing again when the same
    // Do not operate canvas again in other functions
    let renderState;

    function isEqualState(state1, state2) {
        if (!state1 || !state2) return false;
        return Object.keys(state1).reduce((p, c) => {
            return p && state1[c] === state2[c];
        }, true);
    }

    function renderLyrics(ctx, lyrics, currentTime) {
        const focusLineFontSize = userConfigs.fontSize;
        const focusLineHeight = focusLineFontSize * 1.2;
        const focusLineMargin = focusLineFontSize * 1;
        const otherLineFontSize = focusLineFontSize * 1;
        const otherLineHeight = otherLineFontSize * 1.2;
        const otherLineMargin = otherLineFontSize * 1;
        const otherLineOpacity = 0.35;
        const marginWidth = ctx.canvas.width * 0.075;
        const animateDuration = userConfigs.smooth ? 0.3 : 0;
        const hCenter = userConfigs.centerAlign;
        const fontFamily = `${userConfigs.fontFamily}, sans-serif`;

        let currentIndex = -1;
        let progress = 1;
        lyrics.forEach(({
            startTime
        }, index) => {
            if (startTime && currentTime > startTime - animateDuration) {
                currentIndex = index;
                if (currentTime < startTime) {
                    progress = (currentTime - startTime + animateDuration) / animateDuration;
                }
            }
        });

        if (currentIndex == -1) {
            drawText(ctx, "");
            return;
        }

        const nextState = {
            ...userConfigs,
            currentIndex,
            lyrics,
            progress
        };
        if (isEqualState(nextState, renderState)) return;
        renderState = nextState;

        drawBackground(ctx, userConfigs.backgroundImage);

        const {
            offscreenCtx,
            gradient1
        } = initOffscreenCtx(ctx);
        offscreenCtx.save();

        // focus line
        const fFontSize = otherLineFontSize + progress * (focusLineFontSize - otherLineFontSize);
        const fLineHeight = otherLineHeight + progress * (focusLineHeight - otherLineHeight);
        const fLineOpacity = otherLineOpacity + progress * (1 - otherLineOpacity);
        const otherRight =
            ctx.canvas.width -
            marginWidth -
            (otherLineFontSize / focusLineFontSize) * (ctx.canvas.width - 2 * marginWidth);
        const progressRight = marginWidth + (1 - progress) * (otherRight - marginWidth);
        offscreenCtx.fillStyle = `rgba(255, 255, 255, ${fLineOpacity})`;
        offscreenCtx.font = `bold ${fFontSize}px ${fontFamily}`;
        const prevLineFocusHeight = drawParagraph(offscreenCtx, lyrics[currentIndex - 1] ? lyrics[currentIndex - 1].text : "", {
            vCenter: true,
            hCenter,
            left: marginWidth,
            right: marginWidth,
            lineHeight: focusLineFontSize,
            measure: true,
        }).height;

        const pos = drawParagraph(offscreenCtx, lyrics[currentIndex].text, {
            vCenter: true,
            hCenter,
            left: marginWidth,
            right: progressRight,
            lineHeight: fLineHeight,
            translateY: (selfHeight) =>
                ((prevLineFocusHeight + selfHeight) / 2 + focusLineMargin) * (1 - progress),
        });
        // offscreenCtx.strokeRect(pos.left, pos.top, pos.width, pos.height);

        // prev line
        let lastBeforePos = pos;
        for (let i = 0; i < currentIndex; i++) {
            if (i === 0) {
                const prevProgressLineFontSize =
                    otherLineFontSize + (1 - progress) * (focusLineFontSize - otherLineFontSize);
                const prevProgressLineOpacity = otherLineOpacity + (1 - progress) * (1 - otherLineOpacity);
                offscreenCtx.fillStyle = `rgba(255, 255, 255, ${prevProgressLineOpacity})`;
                offscreenCtx.font = `bold ${prevProgressLineFontSize}px ${fontFamily}`;
            } else {
                offscreenCtx.fillStyle = `rgba(255, 255, 255, ${otherLineOpacity})`;
                offscreenCtx.font = `bold ${otherLineFontSize}px ${fontFamily}`;
            }
            lastBeforePos = drawParagraph(offscreenCtx, lyrics[currentIndex - 1 - i].text, {
                hCenter,
                bottom: i === 0 ? lastBeforePos.top - focusLineMargin : lastBeforePos.top - otherLineMargin,
                left: marginWidth,
                right: i === 0 ? marginWidth + progress * (otherRight - marginWidth) : otherRight,
                lineHeight: i === 0 ?
                    otherLineHeight + (1 - progress) * (focusLineHeight - otherLineHeight) : otherLineHeight,
            });
            if (lastBeforePos.top < 0) break;
        }
        // next line
        offscreenCtx.fillStyle = `rgba(255, 255, 255, ${otherLineOpacity})`;
        offscreenCtx.font = `bold ${otherLineFontSize}px ${fontFamily}`;
        let lastAfterPos = pos;
        for (let i = currentIndex + 1; i < lyrics.length; i++) {
            lastAfterPos = drawParagraph(offscreenCtx, lyrics[i].text, {
                hCenter,
                top: i === currentIndex + 1 ?
                    lastAfterPos.bottom + focusLineMargin : lastAfterPos.bottom + otherLineMargin,
                left: marginWidth,
                right: otherRight,
                lineHeight: otherLineHeight,
            });
            if (lastAfterPos.bottom > ctx.canvas.height) break;
        }

        offscreenCtx.globalCompositeOperation = 'source-in';
        offscreenCtx.fillStyle = gradient1;
        offscreenCtx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        offscreenCtx.restore();
        ctx.drawImage(offscreenCtx.canvas, 0, 0);

        ctx.restore();
    }

    let workerIsRunning = null;

    async function tick(options) {
        if (!lyricVideoIsOpen) {
            return;
        }

        const audio = {
            currentTime: Player.getProgress() / 1000,
            duration: Player.getDuration() / 1000,
        };

        const {
            error,
            lyrics,
        } = sharedData;

        if (error) {
            drawText(lyricCtx, error, 'red');
        } else if (!lyrics) {
            drawText(lyricCtx, "No lyric");
        } else if (audio.duration && lyrics.length) {
            renderLyrics(lyricCtx, lyrics, audio.currentTime);
        } else if (!audio.duration || lyrics.length === 0) {
            drawText(
                lyricCtx,
                audio.currentSrc ? "Loading" : "Waiting"
            );
        }
        if (lyrics && lyrics.length) {
            if (document.hidden) {
                if (!workerIsRunning) {
                    worker.postMessage("popup-lyric-request-update");
                    workerIsRunning = true;
                }
            } else {
                if (workerIsRunning) {
                    worker.postMessage("popup-lyric-stop-update");
                    workerIsRunning = false;
                }

                requestAnimationFrame(() => tick(options));
            }
        } else {
            setTimeout(tick, 80, options);
        }
    }

    function boolLocalStorage(name, defaultVal = true) {
        const value = LocalStorage.get(name);
        return value ? value === "true" : defaultVal;
    }

    let configContainer;

    function openConfig(event) {
        event.preventDefault();
        if (!configContainer) {
            configContainer = document.createElement("div");
            configContainer.id = "popup-config-container"
            const style = document.createElement("style");
            style.innerHTML = `
.setting-row::after {
    content: "";
    display: table;
    clear: both;
}
.setting-row .col {
    display: flex;
    padding: 10px 0;
    align-items: center;
}
.setting-row .col.description {
    float: left;
    padding-right: 15px;
    cursor: default;
}
.setting-row .col.action {
    float: right;
    text-align: right;
}
button.switch {
    align-items: center;
    border: 0px;
    border-radius: 50%;
    background-color: rgba(var(--modspotify_rgb_main_fg),0.1);
    color: var(--modspotify_main_fg);
    cursor: pointer;
    display: flex;
    margin-inline-start: 12px;
    padding: 8px;
}
button.switch.disabled,
button.switch[disabled] {
    color: rgba(var(--modspotify_rgb_main_fg), 0.3);
}
button.switch.small {
    width: 22px;
    height: 22px;
    padding: 6px;
}
select {
    color: rgba(var(--modspotify_rgb_main_fg),.7);
    background: var(--modspotify_scrollbar_fg_and_selected_row_bg);
    border: 0;
    height: 32px;
}
input {
    width: 100%;
    margin-top: 10px;
    padding: 0 5px;
    height: 32px;
    border: 0;
}`;
            const optionHeader = document.createElement("h2");
            optionHeader.innerText = "Options";
            const smooth = createSlider("Smooth scrolling", userConfigs.smooth, (state) => {
                userConfigs.smooth = state;
                LocalStorage.set("popup-lyrics:smooth", String(state));
            });
            const center = createSlider("Center align", userConfigs.centerAlign, (state) => {
                userConfigs.centerAlign = state;
                LocalStorage.set("popup-lyrics:center-align", String(state));
            });
            const cover = createSlider("Show cover", userConfigs.showCover, (state) => {
                userConfigs.showCover = state;
                LocalStorage.set("popup-lyrics:show-cover", String(state));
            });
            const ratio = createOptions(
                "Aspect ratio",
                { "11": "1:1", "43": "4:3", "169": "16:9" },
                userConfigs.ratio,
                (state) => {
                    userConfigs.ratio = state;
                    LocalStorage.set("popup-lyrics:ratio", state);
                    let value = lyricVideo.width;
                    switch(userConfigs.ratio) {
                        case "11": value = lyricVideo.width; break;
                        case "43": value = Math.round(lyricVideo.width * 3 / 4); break;
                        case "169": value = Math.round(lyricVideo.width * 9 / 16); break;
                    }
                    lyricVideo.height = lyricCanvas.height = value;
                    offscreenCtx = null;
                }
            );
            const fontSize = createOptions(
                "Font size",
                { 
                    "30": "30px", "34": "34px", "38": "38px", "42": "42px", 
                    "46": "46px", "50": "50px", "54": "54px", "58": "58px", 
                },
                String(userConfigs.fontSize),
                (state) => {
                    userConfigs.fontSize = Number(state);
                    LocalStorage.set("popup-lyrics:font-size", state);
                }
            );

            const serviceHeader = document.createElement("h2");
            serviceHeader.innerText = "Services";

            const serviceContainer = document.createElement("div");

            function stackServiceElements() {
                userConfigs.servicesOrder.forEach((name, index) => {
                    const el = userConfigs.services[name].element;

                    const [ up, down ] = el.querySelectorAll("button");
                    if (index === 0) {
                        up.disabled = true;
                        down.disabled = false;
                    } else if (index === (userConfigs.servicesOrder.length - 1)) {
                        up.disabled = false;
                        down.disabled = true;
                    } else {
                        up.disabled = false;
                        down.disabled = false;
                    }

                    serviceContainer.append(el);
                });
            }

            function switchCallback(el, state) {
                const id = el.dataset.id;
                userConfigs.services[id].on = state;
                LocalStorage.set(`popup-lyrics:services:${id}:on`, state);
                updateTrack();
            }

            function posCallback(el, dir) {
                const id = el.dataset.id;
                const curPos = userConfigs.servicesOrder.findIndex((val) => val === id);
                const newPos = curPos + dir;

                const temp = userConfigs.servicesOrder[newPos];
                userConfigs.servicesOrder[newPos] = userConfigs.servicesOrder[curPos];
                userConfigs.servicesOrder[curPos] = temp;
                
                LocalStorage.set(
                    "popup-lyrics:services-order",
                    JSON.stringify(userConfigs.servicesOrder)
                );

                stackServiceElements();
                updateTrack();
            }

            function tokenChangeCallback(el, inputEl) {
                const newVal = inputEl.value;
                const id = el.dataset.id;
                userConfigs.services[id].token = newVal;
                LocalStorage.set(`popup-lyrics:services:${id}:token`, newVal);
                updateTrack();
            }

            userConfigs.servicesOrder.forEach(name => {
                userConfigs.services[name].element = createServiceOption(
                    name,
                    userConfigs.services[name],
                    switchCallback,
                    posCallback,
                    tokenChangeCallback,
                );
            });
            stackServiceElements();

            configContainer.append(
                style, 
                optionHeader,
                smooth, center, cover, fontSize, ratio,
                serviceHeader,
                serviceContainer
            );
        }
        Spicetify.PopupModal.display({
            title: "Popup Lyrics",
            content: configContainer,
        });
    }

    function createSlider(name, defaultVal, callback) {
        const container = document.createElement("div");
        container.innerHTML = `
<div class="setting-row">
    <label class="col description">${name}</label>
    <div class="col action"><button class="switch">
        <svg height="16" width="16" viewBox="0 0 16 16" fill="currentColor">
            ${Spicetify.SVGIcons.check}
        </svg>
    </button></div>
</div>`;

        const slider = container.querySelector("button");
        slider.classList.toggle("disabled", !defaultVal);

        slider.onclick = () => {
            const state = slider.classList.contains("disabled");
            slider.classList.toggle("disabled");
            callback(state);
        };

        return container;
    }
    function createOptions(name, options, defaultValue, callback) {
        const container = document.createElement("div");
        container.innerHTML = `
<div class="setting-row">
    <label class="col description">${name}</label>
    <div class="col action">
        <select>
            ${Object.keys(options).map((item) => `
                <option value="${item}" dir="auto">${options[item]}</option>
            `).join("\n")}
        </select>
    </div>
</div>`;

        const select = container.querySelector("select");
        select.value = defaultValue;
        select.onchange = (e) => {
            callback(e.target.value);
        }

        return container
    }

    function createServiceOption(id, defaultVal, switchCallback, posCallback, tokenCallback) {
        const name = id.replace(/^./, (c) => c.toUpperCase());

        const container = document.createElement("div");
        container.dataset.id = id;
        container.innerHTML = `
<div class="setting-row">
    <h3 class="col description">${name}</h3>
    <div class="col action">
        <button class="switch small">
            <svg height="10" width="10" viewBox="0 0 16 16" fill="currentColor">
                ${Spicetify.SVGIcons["chart-up"]}
            </svg>
        </button>
        <button class="switch small">
            <svg height="10" width="10" viewBox="0 0 16 16" fill="currentColor">
                ${Spicetify.SVGIcons["chart-down"]}
            </svg>
        </button>
        <button class="switch">
            <svg height="16" width="16" viewBox="0 0 16 16" fill="currentColor">
                ${Spicetify.SVGIcons["check"]}
            </svg>
        </button>
    </div>
</div>
<span>${defaultVal.desc}</span>`;

        if (defaultVal.token !== undefined) {
            const input = document.createElement("input");
            input.placeholder = `Place your ${id} token here`;
            input.value = defaultVal.token;
            input.onchange = () => tokenCallback(container, input);
            container.append(input);
        }

        const [ up, down, slider ] = container.querySelectorAll("button");

        slider.classList.toggle("disabled", !defaultVal.on);
        slider.onclick = () => {
            const state = slider.classList.contains("disabled");
            slider.classList.toggle("disabled");
            switchCallback(container, state);
        }

        up.onclick = () => posCallback(container, -1);
        down.onclick = () => posCallback(container, 1);

        return container;
    }

    button.oncontextmenu = openConfig;
};
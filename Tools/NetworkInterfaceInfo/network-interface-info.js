(function () {
  "use strict";

  const NAME = "Network Interface Info";
  const METRICS = [
    "out",
    "in",
    "outMaxSpeed",
    "inMaxSpeed"
  ];
  const options = parseArguments(
    typeof $argument === "string" ? $argument : ""
  );

  run()
    .then($done)
    .catch(error => {
      console.log(`[${NAME}] ${messageFor(error)}`);
      $done({
        title: NAME,
        content: `Traffic data unavailable.\n${messageFor(error)}`,
        style: "error"
      });
    });

  async function run() {
    const interfaces = await getInterfaces();
    const sections = [
      {
        name: "Wifi",
        value: selectWifi(interfaces)
      },
      {
        name: "Cellular",
        value: aggregateMatching(interfaces, /^pdp_ip\d+$/)
      }
    ];

    return {
      title: NAME,
      content: sections.map(formatSection).join("\n\n"),
      icon: options.icon,
      "icon-color": options.iconColor
    };
  }

  function parseArguments(raw) {
    const values = {};

    String(raw).split("&").forEach(part => {
      const separator = part.indexOf("=");
      if (separator < 1) return;

      const key = part.slice(0, separator).trim();
      let value = part.slice(separator + 1).trim();
      try {
        value = decodeURIComponent(value);
      } catch (_) {}
      values[key] = value;
    });

    return {
      style: values.style === "normal" ? "normal" : "compact",
      icon: values.icon || "wifi.router",
      iconColor: /^#[0-9a-f]{6}$/i.test(values.icon_color || "")
        ? values.icon_color
        : "#6699FF"
    };
  }

  function getInterfaces() {
    return new Promise((resolve, reject) => {
      try {
        $httpAPI("GET", "/v1/traffic", {}, result => {
          if (!result || typeof result !== "object") {
            reject(new Error("Surge returned an invalid traffic response"));
            return;
          }
          if (result.error) {
            reject(new Error(String(result.error)));
            return;
          }
          if (!result.interface || typeof result.interface !== "object") {
            reject(new Error("Interface traffic data is missing"));
            return;
          }
          resolve(result.interface);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function selectWifi(interfaces) {
    if (isMetricObject(interfaces.en0)) return normalize(interfaces.en0);

    const fallback = Object.keys(interfaces)
      .filter(key => /^en\d+$/.test(key) && isMetricObject(interfaces[key]))
      .sort()[0];

    return fallback ? normalize(interfaces[fallback]) : null;
  }

  function aggregateMatching(interfaces, pattern) {
    const matches = Object.keys(interfaces)
      .filter(key => pattern.test(key) && isMetricObject(interfaces[key]))
      .map(key => normalize(interfaces[key]));

    if (!matches.length) return null;

    return matches.reduce((total, item) => {
      METRICS.forEach(metric => {
        if (metric === "outMaxSpeed" || metric === "inMaxSpeed") {
          total[metric] = Math.max(total[metric], item[metric]);
        } else {
          total[metric] += item[metric];
        }
      });
      return total;
    }, emptyMetrics());
  }

  function isMetricObject(value) {
    return Boolean(value && typeof value === "object");
  }

  function emptyMetrics() {
    return METRICS.reduce((result, metric) => {
      result[metric] = 0;
      return result;
    }, {});
  }

  function normalize(value) {
    return METRICS.reduce((result, metric) => {
      const number = Number(value[metric]);
      result[metric] = Number.isFinite(number) && number > 0 ? number : 0;
      return result;
    }, {});
  }

  function formatSection(section) {
    if (!section.value) return `${section.name}\nUnavailable`;

    const item = section.value;
    if (options.style === "normal") {
      return [
        section.name,
        `Uploaded: ${formatBytes(item.out)}`,
        `Downloaded: ${formatBytes(item.in)}`,
        `Maximum Upload Speed: ${formatBytes(item.outMaxSpeed)}/s`,
        `Maximum Download Speed: ${formatBytes(item.inMaxSpeed)}/s`
      ].join("\n");
    }

    return [
      section.name,
      `Traffic: Up ${formatBytes(item.out)} | Down ${formatBytes(item.in)}`,
      `Maximum Speed: Up ${formatBytes(item.outMaxSpeed)}/s | Down ${formatBytes(item.inMaxSpeed)}/s`
    ].join("\n");
  }

  function formatBytes(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return "0 B";

    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    const index = Math.min(
      Math.floor(Math.log(number) / Math.log(1024)),
      units.length - 1
    );
    const scaled = number / Math.pow(1024, index);
    const precision = index === 0 ? 0 : 2;

    return `${Number(scaled.toFixed(precision))} ${units[index]}`;
  }

  function messageFor(error) {
    return error && error.message ? error.message : String(error || "Unknown error");
  }
})();

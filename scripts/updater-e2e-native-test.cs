    // Injected into disposable E2E fixture assemblies ONLY, never production.
    private bool fixtureStarted;
    private async Task FixtureWait(string script, int seconds) {
        var deadline = DateTime.UtcNow.AddSeconds(seconds);
        while (DateTime.UtcNow < deadline) {
            if (await view.CoreWebView2.ExecuteScriptAsync(script) == "true") return;
            await Task.Delay(200);
        }
        throw new IOException("Fixture UI wait failed.");
    }
    private async void FixtureDriver() {
        if (fixtureStarted) return; fixtureStarted = true;
        try {
            await FixtureWait("!!document.getElementById('updatesSettingsTab')", 30);
            await view.CoreWebView2.ExecuteScriptAsync("document.getElementById('updatesSettingsTab').click()");
            await FixtureWait("!!lastUpdateStatus && !lastUpdateStatus.busy", 30);
            string version = Convert.ToString((await NativeRequestAsync("/api/desktop/updates", new { action = "status" }))["currentVersion"]);
            if (version == "0.1.1") {
                await NativeRequestAsync("/api/desktop/security", new { action = "preference", requireDesktopPin = false, confirmed = true });
                await NativeRequestAsync("/api/desktop/updates", new { action = "preference" });
                await NativeRequestAsync("/api/desktop/updates", new { action = "preference" });
                await view.CoreWebView2.ExecuteScriptAsync("document.getElementById('checkUpdates').click()");
                await FixtureWait("!!lastUpdateStatus && lastUpdateStatus.available && lastUpdateStatus.state==='available' && !lastUpdateStatus.busy && !document.getElementById('installUpdate').disabled", 30);
                await view.CoreWebView2.ExecuteScriptAsync("document.getElementById('installUpdate').click()");
                await FixtureWait("!!lastUpdateStatus && lastUpdateStatus.state==='failed' && !lastUpdateStatus.busy", 210);
                await view.CoreWebView2.ExecuteScriptAsync("window.__fixtureMetrics=null;void fetch('/api/metrics').then(r=>window.__fixtureMetrics=r.status)");
                await FixtureWait("window.__fixtureMetrics===200", 10);
                File.WriteAllText(@"REPORT_PATH", json.Serialize(new { phase = "failure-tested", failureRecovery = true }));
                var limit = DateTime.UtcNow.AddSeconds(60);
                while (!File.ReadAllText(@"CONTROL_PATH").Contains("\"allowUpgrade\":true")) {
                    if (DateTime.UtcNow >= limit) throw new IOException("Fixture approval wait failed.");
                    await Task.Delay(200);
                }
                await view.CoreWebView2.ExecuteScriptAsync("document.getElementById('checkUpdates').click()");
                await FixtureWait("!!lastUpdateStatus && lastUpdateStatus.available && lastUpdateStatus.state==='available' && !lastUpdateStatus.busy && !document.getElementById('installUpdate').disabled", 30);
                await view.CoreWebView2.ExecuteScriptAsync("document.getElementById('installUpdate').click()");
            } else if (version == "0.1.2") {
                await NativeRequestAsync("/api/desktop/updates", new { action = "preference" });
                await NativeRequestAsync("/api/desktop/updates", new { action = "preference" });
                await FixtureWait("document.getElementById('updateCurrentVersion').textContent==='0.1.2'", 30);
                await view.CoreWebView2.ExecuteScriptAsync("document.getElementById('checkUpdates').click()");
                await FixtureWait("!!lastUpdateStatus && !lastUpdateStatus.busy && lastUpdateStatus.state==='current'", 35);
                File.WriteAllText(@"REPORT_PATH", json.Serialize(new { phase = "reopened", version = version, nativeUpdatesDisplayed = true, checkWorks = true }));
            } else throw new IOException("Unexpected fixture version.");
        } catch { File.WriteAllText(@"REPORT_PATH", json.Serialize(new { phase = "failed" })); }
    }
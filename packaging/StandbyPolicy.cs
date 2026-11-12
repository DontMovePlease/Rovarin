using System;
using System.Collections.Generic;

// Pure supervisor decision core. No listener/process launching is enabled here.
// Only authenticated canonical backend/native IPC may call Heartbeat/SetOperations.
internal sealed class StandbyPolicy {
    readonly Dictionary<string,long> clients=new Dictionary<string,long>();
    readonly long timeout;
    long idleSince;
    bool operationsKnown;
    bool protectedOperation;
    public StandbyPolicy(long now,int timeoutSeconds=45) {
        if(timeoutSeconds<20||timeoutSeconds>60)throw new ArgumentOutOfRangeException("timeoutSeconds");
        timeout=timeoutSeconds*1000L;idleSince=now;
    }
    public bool Heartbeat(string id,bool authenticated,long now) {
        if(!authenticated||String.IsNullOrEmpty(id)||id.Length>128)return false;
        var expired=new List<string>();foreach(var pair in clients)if(now>=pair.Value&&now-pair.Value>=timeout)expired.Add(pair.Key);
        foreach(string key in expired)clients.Remove(key);
        if(!clients.ContainsKey(id)&&clients.Count>=16)return false;
        clients[id]=now;idleSince=now;return true;
    }
    public void Disconnect(string id,long now) {if(id!=null&&clients.Remove(id))idleSince=now;}
    public void SetOperations(bool known,bool busy) {operationsKnown=known;protectedOperation=busy;}
    public bool MayStop(long now) {
        if(!operationsKnown||protectedOperation||now<idleSince)return false;
        foreach(long seen in clients.Values)if(now<seen||now-seen<timeout)return false;
        return now-idleSince>=timeout;
    }
}

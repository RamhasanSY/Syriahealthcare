// "My account": shows who is signed in and what comes next for each role.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api} = Shc;
    const roles = {patient: ['Patient', 'مريض'], doctor: ['Doctor', 'طبيب'], admin: ['Administrator', 'مدير']};
    const res = await api('/api/me');
    $('main').setAttribute('aria-busy', 'false');
    if (!res.ok) {
        $('signedOut').hidden = false;
        return;
    }
    const user = res.data.user;
    const render = () => {
        $('greeting').textContent = tr(`Hello, ${user.name}`, `مرحباً، ${user.name}`);
        $('userName').textContent = user.name;
        $('userRole').textContent = tr(...roles[user.role]);
        $('contactLabel').textContent = user.role === 'patient' ? tr('Mobile', 'الجوال') : tr('Email', 'البريد الإلكتروني');
        $('userContact').textContent = user.role === 'patient' ? user.phone : user.email;
    };
    document.addEventListener('shc:language', render);
    render();
    $('details').hidden = false;
    $(user.role + 'Next').hidden = false;
    $('logout').hidden = false;
    $('logout').addEventListener('click', async () => {
        await api('/api/auth/logout', {});
        window.location.assign('/');
    });
});
